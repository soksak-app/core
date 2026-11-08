//go:build diagnostics

package host

import (
	"encoding/json"
	"strings"
	"testing"
)

// contract: diagnostics.capture.document-reference.is-declared
func TestDocumentReferenceObservationIsPubliclyDeclared(t *testing.T) {
	if diagnosticMethods["diagnostics.capture.document-reference"] == nil {
		t.Fatal("diagnostics.capture.document-reference is not registered")
	}
}

// contract: diagnostics.capture.document-reference.rejects-invalid-request-before-platform-dispatch
func TestDocumentReferenceObservationRejectsInvalidRequests(t *testing.T) {
	method := diagnosticMethods["diagnostics.capture.document-reference"]
	if method == nil {
		t.Fatal("diagnostics.capture.document-reference is not registered")
	}
	for _, params := range []string{
		`{"window":"main","document":"page","requestId":1}`,
		`{"window":"main","surface":"","document":"page","requestId":1}`,
		`{"window":"main","surface":"browser-a","requestId":1}`,
		`{"window":"main","surface":"browser-a","document":"Not A Name","requestId":1}`,
		`{"window":"main","surface":"browser-a","document":"page","requestId":0}`,
		`{"window":"main","surface":"browser-a","document":"page","requestId":9007199254740992}`,
		`{"window":"main","surface":"browser-a","document":"page","requestId":1,"expected":{"text":"invented producer truth"}}`,
	} {
		_, err := method(nil, nil, json.RawMessage(params), nil)
		if err == nil || !strings.Contains(err.Error(), "document reference") {
			t.Fatalf("invalid reference request %s returned %v", params, err)
		}
	}
	for _, document := range []string{"", "page"} {
		params := `{"window":"main","surface":"browser-a","document":"` + document + `","requestId":1}`
		request, err := parseDocumentReferenceRequest(json.RawMessage(params))
		want := documentReferenceRequest{Surface: "browser-a", Document: document, RequestID: 1}
		if err != nil || request != want {
			t.Fatalf("valid reference request %s returned %+v, %v", params, request, err)
		}
	}
}
