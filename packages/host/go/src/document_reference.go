//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

func init() {
	diagnosticMethods["diagnostics.capture.document-reference"] = diagnosticCaptureDocumentReference
}

type documentReferenceRequest struct {
	Surface   string
	Document  string
	RequestID uint64
}

func parseDocumentReferenceRequest(params json.RawMessage) (documentReferenceRequest, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(params, &fields); err != nil {
		return documentReferenceRequest{}, rpcError(codeInvalidParams, "document reference parameters must be an object")
	}
	for field := range fields {
		if field != "window" && field != "surface" && field != "document" && field != "requestId" {
			return documentReferenceRequest{}, rpcError(codeInvalidParams, "document reference parameter %q is not declared", field)
		}
	}
	var request struct {
		Surface   *string `json:"surface"`
		Document  *string `json:"document"`
		RequestID *uint64 `json:"requestId"`
	}
	if err := decode(params, &request); err != nil {
		return documentReferenceRequest{}, fmt.Errorf("document reference: %w", err)
	}
	if request.Surface == nil || *request.Surface == "" || request.Document == nil || !documentName.MatchString(*request.Document) {
		return documentReferenceRequest{}, rpcError(codeInvalidParams, "document reference requires an exact surface and document name (empty for the root)")
	}
	if request.RequestID == nil || *request.RequestID == 0 || *request.RequestID > maxSourceGeneration {
		return documentReferenceRequest{}, rpcError(codeInvalidParams, "document reference requestId must be a positive JavaScript safe integer")
	}
	return documentReferenceRequest{Surface: *request.Surface, Document: *request.Document, RequestID: *request.RequestID}, nil
}

func diagnosticCaptureDocumentReference(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	request, err := parseDocumentReferenceRequest(params)
	if err != nil {
		return nil, err
	}
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	observer, ok := system.(platform.DocumentReferenceCapture)
	if !ok {
		return nil, errors.New("document reference observation is not implemented on this platform")
	}
	if s.invoke == nil {
		return nil, errors.New("document reference has no UI-thread dispatcher")
	}
	// Resolve the live host view incarnation, never a request-supplied generation.
	var generation uint64
	var target unsafe.Pointer
	var resolveErr error
	s.invoke(func() {
		view, exists := s.documents.view(request.Surface)
		if !exists || view.generation == 0 {
			resolveErr = errors.New("document reference surface has no current renderer view")
			return
		}
		generation = view.generation
		target, resolveErr = s.documents.Get(DocumentKey{Surface: request.Surface, Name: request.Document})
	})
	if resolveErr != nil {
		return nil, resolveErr
	}
	resolve := func() (unsafe.Pointer, error) {
		view, exists := s.documents.view(request.Surface)
		if !exists || view.generation != generation {
			return nil, errors.New("document reference renderer incarnation changed")
		}
		current, err := s.documents.Get(DocumentKey{Surface: request.Surface, Name: request.Document})
		if err != nil {
			return nil, err
		}
		if current != target {
			return nil, errors.New("document reference native target was replaced")
		}
		return current, nil
	}
	// The capture-stop owner will freeze/remove the selected source even when
	// the start or subsequent observation times out or returns invalid metadata.
	identity, err := startDocumentFrameIdentity(s, request.Surface, generation, resolve, observer.StartDocumentReferenceIdentity)
	if err != nil {
		return nil, err
	}
	directory := filepath.Join(h.workspace.directory, "logs", "captures", fmt.Sprintf("document-reference-%d-%d", request.RequestID, time.Now().UnixNano()))
	if err := system.PrivateDirectory(directory); err != nil {
		return nil, err
	}
	raw, err := awaitDocumentObservation(s, "document reference", func(done func(json.RawMessage, error)) error {
		document, err := resolve()
		if err != nil {
			return err
		}
		return observer.ObserveDocumentReference(document, request.RequestID, directory, done)
	})
	if err != nil {
		return nil, fmt.Errorf("document reference artifacts retained at %s: %w", directory, err)
	}
	var reply map[string]any
	if err := json.Unmarshal(raw, &reply); err != nil {
		return nil, fmt.Errorf("document reference native result is not JSON: %w", err)
	}
	if reply["requestId"] != float64(request.RequestID) {
		return nil, errors.New("document reference result belongs to another request")
	}
	reply["identityStart"] = identity
	reply["generation"] = generation
	reply["target"] = map[string]string{"surface": request.Surface, "document": request.Document}
	reply["directory"] = directory
	return reply, nil
}
