// Forwarding of exposure requests and the host entries.
//
// The host forwards a request of the endpoint to the main page of the window as an exposure-request event, and the page replies with
// ExposureReply. For an entry that a surface page registered, the main page requests it through ExposureForward and
// the host forwards it to that surface page. The host handles host-owned entries directly.
// The forms are defined in docs/spec/exposure.md.

package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// pageTimeout is the time to wait for a reply of a document.
const pageTimeout = 10 * time.Second

// hostEntry is one entry that the host declares.
type hostEntry struct {
	Description string
	// Schema is the schema of a status value, and Params and Result are the parameter and result schemas of a command.
	Schema, Params, Result map[string]any
}

// rectSchema is the schema of {x, y, width, height}.
var rectSchema = map[string]any{"type": "object", "properties": map[string]any{
	"x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"},
	"width": map[string]any{"type": "number"}, "height": map[string]any{"type": "number"},
}}

var emptyObject = map[string]any{"type": "object", "properties": map[string]any{}}
var nullSchema = map[string]any{"type": "null"}

// presentedSchema is the result of host.window.presented. displayed is the display time (ms, mach absolute time).
var presentedSchema = map[string]any{"type": "object", "properties": map[string]any{"displayed": map[string]any{"type": "number"}}}

var hostStatus = map[string]hostEntry{
	"host.window": {
		Description: "Window frame and system pointer location in screen coordinates, content size, backing scale, the maximum refresh rate of its screen (null when the window is on no screen), maximized, key and application active state, whether other windows cover the whole window, child window count, the WebContent process of the app page (0 before it starts), whether the application is quitting, window buttons, webview frames, native surfaces, document regions, image regions, and the open native modal.",
		Schema: map[string]any{"type": "object", "properties": map[string]any{
			"frame":       rectSchema,
			"pointer":     map[string]any{"type": "object", "properties": map[string]any{"x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"}}},
			"content":     rectSchema,
			"scale":       map[string]any{"type": "number"},
			"refreshRate": map[string]any{"type": []string{"integer", "null"}},
			"pageProcess": map[string]any{"type": "integer"},
			"quitting":    map[string]any{"type": "boolean"},
			"maximized":   map[string]any{"type": "boolean"},
			"key":         map[string]any{"type": "boolean"},
			"active":      map[string]any{"type": "boolean"},
			"occluded":    map[string]any{"type": "boolean"},
			"children":    map[string]any{"type": "integer"},
			"controls":    map[string]any{"type": "array", "items": rectSchema},
			"webviews": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"frame": rectSchema, "main": map[string]any{"type": "boolean"}, "document": map[string]any{"type": "boolean"},
				"visible": map[string]any{"type": "boolean"}, "focused": map[string]any{"type": "boolean"}, "order": map[string]any{"type": "integer"},
			}}},
			"surfaces": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"id": map[string]any{"type": "string"}, "frame": rectSchema,
				"visible": map[string]any{"type": "boolean"}, "order": map[string]any{"type": "integer"},
			}}},
			"documents": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"surface": map[string]any{"type": "string"}, "document": map[string]any{"type": "string"},
				"frame": rectSchema, "visible": map[string]any{"type": "boolean"}, "focused": map[string]any{"type": "boolean"}, "order": map[string]any{"type": "integer"},
			}}},
			"regions": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"surface": map[string]any{"type": "string"}, "name": map[string]any{"type": "string"},
				"frame": rectSchema, "visible": map[string]any{"type": "boolean"}, "focused": map[string]any{"type": "boolean"},
				"presented": map[string]any{"type": []any{"object", "null"}, "properties": map[string]any{
					"sequence": map[string]any{"type": "integer"}, "generation": map[string]any{"type": "integer"}, "raster": map[string]any{"type": "integer"},
					"width": map[string]any{"type": "integer"}, "height": map[string]any{"type": "integer"}, "scale": map[string]any{"type": "number"},
				}},
				"error": map[string]any{"type": []any{"string", "null"}},
			}}},
			"modal": map[string]any{"type": "object", "properties": map[string]any{
				"id": map[string]any{"type": "string"}, "mode": map[string]any{"type": "string"},
				"shown": map[string]any{"type": "boolean"}, "frame": rectSchema, "order": map[string]any{"type": "integer"},
				"background": map[string]any{"type": "object", "properties": map[string]any{
					"draws": map[string]any{"type": "boolean"}, "alpha": map[string]any{"type": "number"},
				}},
			}},
		}},
	},
	"host.buttons": {
		Description: "The mouse buttons that AppKit reports as pressed: {mask}, the NSEvent.pressedMouseButtons mask (bit 0 left, bit 1 right). It changes with a press or release of a person's button in any application; input.pointer refuses a press or release with 1007 while it is not 0.",
		Schema:      map[string]any{"type": "object", "properties": map[string]any{"mask": map[string]any{"type": "integer"}}},
	},
	"host.log": {
		Description: "The latest notice of a change of the event log: {path, size, notices, coalesced}. path is the event file under the configuration folder (logs/<name>) and size its size in bytes; notices counts the notices published since the start, at most one per 250 ms, and coalesced counts the announcements that were folded into a later notice. A line announces a change except the record of a call that only reads the log. The page follows the same notice with the host event debug-log-changed; a client queries log.query with since after a notice.",
		Schema: map[string]any{"type": "object", "properties": map[string]any{
			"path": map[string]any{"type": "string"}, "size": map[string]any{"type": "integer"},
			"notices": map[string]any{"type": "integer"}, "coalesced": map[string]any{"type": "integer"},
		}},
	},
	"host.screens": {
		Description: "The displays in screen coordinates with their backing scale and the area not covered by the menu bar and Dock.",
		Schema: map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
			"visible": rectSchema,
			"x":       map[string]any{"type": "number"}, "y": map[string]any{"type": "number"},
			"width": map[string]any{"type": "number"}, "height": map[string]any{"type": "number"},
			"scale": map[string]any{"type": "number"},
		}}},
	},
	"host.windows": {
		Description: "The windows of the application in the windows.list format.",
		Schema: map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
			"window": map[string]any{"type": "string"}, "title": map[string]any{"type": "string"},
			"project": map[string]any{"type": "string"}, "key": map[string]any{"type": "boolean"},
			"ready": map[string]any{"type": "boolean"},
		}}},
	},
	"host.sidecars": {
		Description: "The surfaces whose closed the host has sent and the sidecar has not answered, sorted by sidecar and surface, and the persistent sidecars whose service runs another version than the installed one, sorted by sidecar, with the running version (null when the service sent none), the installed version and the number of open surfaces of the service: {closing: [{sidecar, surface}], outdated: [{sidecar, running, installed, sessions}]}.",
		Schema: map[string]any{"type": "object", "properties": map[string]any{
			"closing": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"sidecar": map[string]any{"type": "string"}, "surface": map[string]any{"type": "string"},
			}}},
			"outdated": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"sidecar": map[string]any{"type": "string"}, "running": map[string]any{"type": []any{"string", "null"}},
				"installed": map[string]any{"type": "string"}, "sessions": map[string]any{"type": "integer"},
			}}},
		}},
	},
	"host.menu": {
		Description: "The application menu with the active menu language: {language, menus}. Each submenu's title and its items' titles and key equivalents, without separators.",
		Schema: map[string]any{"type": "object", "properties": map[string]any{
			"language": map[string]any{"type": "string"},
			"menus": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"title": map[string]any{"type": "string"},
				"items": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
					"title": map[string]any{"type": "string"},
					"key":   map[string]any{"type": "string"},
				}}},
			}}},
		}},
	},
	"host.dock": {
		Description: "The titles of the application's Dock menu items in order.",
		Schema:      map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
	},
}

var hostCommands = map[string]hostEntry{
	"host.window.close": {Description: "Closes the window through its normal close action.", Params: emptyObject, Result: nullSchema},
	"host.window.maximize": {Description: "Maximizes the window, or restores it with on false.", Result: nullSchema,
		Params: map[string]any{"type": "object", "properties": map[string]any{"on": map[string]any{"type": "boolean"}}}},
	"host.window.fullscreen": {Description: "Enters full screen, or leaves it with on false.", Result: nullSchema,
		Params: map[string]any{"type": "object", "properties": map[string]any{"on": map[string]any{"type": "boolean"}}}},
	"host.window.resize": {Description: "Resizes the content area.", Result: nullSchema,
		Params: map[string]any{"type": "object", "properties": map[string]any{
			"width": map[string]any{"type": "number"}, "height": map[string]any{"type": "number"}}}},
	"host.window.move": {Description: "Moves the window frame origin to a point in screen coordinates.", Result: nullSchema,
		Params: map[string]any{"type": "object", "properties": map[string]any{
			"x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"}}}},
	"host.menu.select": {Description: "Performs the application menu item with the title in the submenu with the menu title.", Result: nullSchema,
		Params: map[string]any{"type": "object", "properties": map[string]any{
			"menu": map[string]any{"type": "string"}, "title": map[string]any{"type": "string"}}}},
	"host.dock.select": {Description: "Performs the Dock menu item with the title.", Result: nullSchema,
		Params: map[string]any{"type": "object", "properties": map[string]any{"title": map[string]any{"type": "string"}}}},
	"host.window.reload":    {Description: "Reloads the main page.", Params: emptyObject, Result: nullSchema},
	"host.window.presented": {Description: "Resolves after the main page, visible application documents, and visible image regions have presented their current geometry and raster, with the display time of that frame.", Params: emptyObject, Result: presentedSchema},
	"host.hit": {Description: "Returns the owner and native hit-view class and frame of a point in window coordinates.",
		Params: map[string]any{"type": "object", "properties": map[string]any{
			"x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"}}},
		Result: map[string]any{"type": "object", "properties": map[string]any{
			"kind":       map[string]any{"type": "string", "enum": []string{"page", "document", "native"}},
			"surface":    map[string]any{"type": "string"},
			"document":   map[string]any{"type": "string"},
			"identifier": map[string]any{"type": "string"},
			"view": map[string]any{"type": []any{"object", "null"}, "properties": map[string]any{
				"class": map[string]any{"type": "string"}, "frame": rectSchema}}}}},
	"host.quit": {Description: "Requests normal application termination, including pending saves.", Params: emptyObject, Result: nullSchema},
}

// listedEntries returns the host entries to put into exposure.list, in the order of their names.
func listedEntries(entries map[string]hostEntry, status bool) []map[string]any {
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]map[string]any, 0, len(names))
	for _, name := range names {
		entry := entries[name]
		item := map[string]any{"name": name, "description": entry.Description, "registered": true}
		if status {
			item["schema"] = entry.Schema
		} else {
			item["params"] = entry.Params
			item["result"] = entry.Result
		}
		out = append(out, item)
	}
	return out
}

// ExposureResult is the reply that a document sent. It holds one result or one error. ExposureForward returns it.
type ExposureResult struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

// Relay connects a request sent to a document with its reply. T identifies the document that received the request, and the reply must come from the same document.
type Relay[T comparable] struct {
	mu      sync.Mutex
	next    uint64
	waiting map[uint64]*relayWaiter[T]
	// expired are the recent requests that timed out. To state the delay of a late reply in the error, it remembers up to relayExpiredLimit
	// of them and discards the oldest (docs/spec/exposure.md#errors).
	expired []relayExpired[T]
}

// relayExpiredLimit is the number of timed-out requests remembered for late replies.
const relayExpiredLimit = 256

type relayExpired[T comparable] struct {
	id      uint64
	target  T
	sent    time.Time
	timeout time.Duration
}

type relayWaiter[T comparable] struct {
	target T
	reply  chan ExposureResult
}

// NewRelay creates an empty relay.
func NewRelay[T comparable]() *Relay[T] {
	return &Relay[T]{waiting: map[uint64]*relayWaiter[T]{}}
}

// Request creates a request id to send to target, sends it with send, and waits for the reply. When send fails, it does not wait and
// returns a 1003 error. When the time limit passes, it deletes the request and returns a 1005 error. When timeout is 0, it waits for a reply or
// Abandon.
func (r *Relay[T]) Request(target T, timeout time.Duration, send func(id uint64) error) ExposureResult {
	r.mu.Lock()
	r.next++
	id := r.next
	w := &relayWaiter[T]{target: target, reply: make(chan ExposureResult, 1)}
	r.waiting[id] = w
	r.mu.Unlock()
	sent := time.Now()
	if err := send(id); err != nil {
		r.mu.Lock()
		delete(r.waiting, id)
		r.mu.Unlock()
		return ExposureResult{Error: rpcError(codeNoWindow, "send request %d: %v", id, err)}
	}
	if timeout == 0 {
		return <-w.reply
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case reply := <-w.reply:
		return reply
	case <-timer.C:
		r.mu.Lock()
		delete(r.waiting, id)
		select {
		case reply := <-w.reply:
			r.mu.Unlock()
			return reply
		default:
		}
		if len(r.expired) == relayExpiredLimit {
			// The oldest entry is forgotten: a late reply to it has no matching request. The loss is counted.
			r.expired = r.expired[1:]
			recordBufferDrop("relay expired requests", 0, fmt.Sprintf("%d requests", relayExpiredLimit))
		}
		r.expired = append(r.expired, relayExpired[T]{id: id, target: target, sent: sent, timeout: timeout})
		r.mu.Unlock()
		return ExposureResult{Error: rpcError(codeTimeout, "the document did not reply within %d ms", timeout.Milliseconds())}
	}
}

// Resolve delivers the reply of a request id. A reply from a document other than the one that received the request and a reply to a request that already ended are errors.
func (r *Relay[T]) Resolve(id uint64, from T, reply ExposureResult) error {
	r.mu.Lock()
	w := r.waiting[id]
	if w == nil || w.target != from {
		defer r.mu.Unlock()
		for i, expired := range r.expired {
			if expired.id == id && expired.target == from {
				r.expired = append(r.expired[:i], r.expired[i+1:]...)
				return fmt.Errorf("exposure reply %d arrived %d ms after it was sent; its request timed out after %d ms",
					id, time.Since(expired.sent).Milliseconds(), expired.timeout.Milliseconds())
			}
		}
		return fmt.Errorf("exposure reply %d has no matching request", id)
	}
	delete(r.waiting, id)
	r.mu.Unlock()
	w.reply <- reply
	return nil
}

// Abandon answers the requests sent to the documents for which match is true with a 1003 error. A document that disappeared does not reply.
func (r *Relay[T]) Abandon(match func(T) bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, w := range r.waiting {
		if !match(w.target) {
			continue
		}
		delete(r.waiting, id)
		w.reply <- ExposureResult{Error: rpcError(codeNoWindow, "the document closed before it replied")}
	}
}

// relayTarget is the main document of a window (surface is empty) or a surface document.
type relayTarget struct {
	owner   *Surfaces
	surface string
}

// ask sends a request to the main page of window s and waits for the reply. When timeout is 0, it waits for a reply or for the page to
// end. A page that is not ready cannot receive the request, so it returns 1003. It checks readiness after it registers the request, so
// the request of a page that was read again in between is rejected here or ends through Abandon.
func (h *Host) ask(s *Surfaces, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	reply := h.relay.Request(relayTarget{owner: s}, timeout, func(id uint64) error {
		h.mu.Lock()
		ready := s.ready
		h.mu.Unlock()
		if !ready {
			return errors.New("the main page is not ready")
		}
		s.window.EmitEvent("exposure-request", map[string]any{"id": id, "method": method, "params": params})
		return nil
	})
	if reply.Error != nil {
		return nil, reply.Error
	}
	if len(reply.Result) == 0 {
		return json.RawMessage(`null`), nil
	}
	return reply.Result, nil
}

// ExposureReplyRequest is the reply that a document sent to one request. Without surface, it is the reply of the main document.
type ExposureReplyRequest struct {
	ID      uint64          `json:"id"`
	Surface json.RawMessage `json:"surface,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error"`
}

// ReplySurface returns the surface that sent the reply. Without the surface field, the reply is from the main document, so the value is empty. null, an empty string, and
// a value that is not a string are rejected as errors and not converted to a reply of the main document.
func ReplySurface(surface json.RawMessage) (string, error) {
	if len(surface) == 0 {
		return "", nil
	}
	var id string
	if err := json.Unmarshal(surface, &id); err != nil || id == "" || string(surface) == "null" {
		return "", fmt.Errorf("exposure reply surface must be a nonempty string, got %s", surface)
	}
	return id, nil
}

// ExposureReply receives the reply that the main page sent to exposure-request.
func (h *Host) ExposureReply(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[ExposureReplyRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	surface, err := ReplySurface(req.Surface)
	if err != nil {
		return err
	}
	if surface == "" {
		return h.relay.Resolve(req.ID, relayTarget{owner: s}, ExposureResult{Result: req.Result, Error: req.Error})
	}
	if err := s.authorizeSurface(uint64(s.window.ID()), surface); err != nil {
		return err
	}
	s.mu.Lock()
	_, attached := s.compositions[surface]
	s.mu.Unlock()
	if !attached {
		// When a surface is removed, surfacesClosed already ended the requests of that surface with 1003. A late reply has no request to answer, so it is
		// discarded and kept as an observation (docs/spec/exposure.md).
		LogInfo("exposure", RemovedSurfaceReply(req.ID, surface))
		return nil
	}
	return h.relay.Resolve(req.ID, relayTarget{owner: s, surface: surface}, ExposureResult{Result: req.Result, Error: req.Error})
}

// RemovedSurfaceReply is the observation line of a late reply that a removed surface sent.
func RemovedSurfaceReply(id uint64, surface string) string {
	return fmt.Sprintf("exposure reply %d of removed surface %q arrived after its request ended", id, surface)
}

// ExposureChange is the new value of a watched status.
type ExposureChange struct {
	Name    string `json:"name"`
	Surface string `json:"surface,omitempty"`
	// Value is the new value of the status. A change whose value is null or missing is a change whose value is null.
	Value json.RawMessage `json:"value,omitempty"`
}

// CheckPageStatusChange checks whether the page can send a status change of the name name. Only the host changes host statuses.
func CheckPageStatusChange(name string) error {
	if isHostName(name) {
		return fmt.Errorf("the page cannot change host status %s", name)
	}
	return nil
}

// ExposureChanged forwards a status change that the main page reported to the connections that watch that status.
func (h *Host) ExposureChanged(ctx context.Context, changeJSON json.RawMessage) error {
	change, err := argument[ExposureChange]("request", changeJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	if err := CheckPageStatusChange(change.Name); err != nil {
		return err
	}
	value := change.Value
	if len(value) == 0 {
		value = json.RawMessage("null")
	}
	h.endpoint.StatusChanged(s.name, change.Name, change.Surface, value)
	return nil
}

// ExposureForwardRequest is the request that the main page forwards to a surface page.
type ExposureForwardRequest struct {
	Surface string          `json:"surface"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	// Timeout is the time limit (ms) of this request. Without it, the limit is 10 seconds. The page forwards the timeout of the declaration.
	Timeout json.RawMessage `json:"timeout,omitempty"`
}

// maxForwardTimeout is the longest time limit that a forwarded request can specify.
const maxForwardTimeout = 600000

// ForwardTimeout decides the time limit of a forwarded request. status.next does not reply until the value changes, so
// it has no time limit (0) and does not accept timeout. timeout is an integer in ms from 1 to 600000.
func ForwardTimeout(method string, timeout json.RawMessage) (time.Duration, *RPCError) {
	if len(timeout) == 0 || string(timeout) == "null" {
		if method == "status.next" {
			return 0, nil
		}
		return pageTimeout, nil
	}
	if method == "status.next" {
		return 0, &RPCError{Code: codeInvalidParams, Message: "status.next has no timeout"}
	}
	var ms float64
	if err := json.Unmarshal(timeout, &ms); err != nil || ms != math.Trunc(ms) || ms < 1 || ms > maxForwardTimeout {
		return 0, &RPCError{Code: codeInvalidParams, Message: fmt.Sprintf("timeout must be an integer from 1 to %d milliseconds", maxForwardTimeout)}
	}
	return time.Duration(ms) * time.Millisecond, nil
}

// ExposureForward forwards a request to a surface page and returns its reply {result} or {error}.
// When the surface does not exist or does not reply, it returns a reply that carries an error.
func (h *Host) ExposureForward(ctx context.Context, reqJSON json.RawMessage) (ExposureResult, error) {
	req, err := argument[ExposureForwardRequest]("request", reqJSON)
	if err != nil {
		return ExposureResult{}, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return ExposureResult{}, err
	}
	timeout, invalid := ForwardTimeout(req.Method, req.Timeout)
	if invalid != nil {
		return ExposureResult{Error: invalid}, nil
	}
	// status.next has no time limit. It ends with 1003 when the surface closes.
	reply := h.relay.Request(relayTarget{owner: s, surface: req.Surface}, timeout, func(id uint64) error {
		var sent bool
		application.InvokeSync(func() {
			if s.views[req.Surface] != nil {
				s.window.EmitEvent("exposure-request", map[string]any{
					"id": id, "surface": req.Surface, "method": req.Method, "params": req.Params,
				})
				sent = true
			}
		})
		if !sent {
			return fmt.Errorf("surface %q is not shown", req.Surface)
		}
		return nil
	})
	if reply.Error == nil && len(reply.Result) == 0 {
		reply.Result = json.RawMessage(`null`)
	}
	return reply, nil
}

// SurfaceRegistration is an entry that a surface page registered.
type SurfaceRegistration struct {
	Surface string `json:"surface"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
}

// surfaceOf returns the id of the surface that the native web view viewID shows. It is empty when the view is not a surface.
func (s *Surfaces) surfaceOf(viewID uint64) string {
	var id string
	application.InvokeSync(func() {
		if view := nativeViews[viewID]; view != nil && view.owner == s {
			id = s.named[uintptr(view.handle)]
		}
	})
	return id
}

// AuthorizeSurfaceCaller verifies a surface request against the explicit caller identity. It allows only an owned surface
// view or the explicit main page identity, and does not treat an unknown view as the main page.
func AuthorizeSurfaceCaller(caller, requested string, callerID, mainID uint64) error {
	if caller != "" {
		if caller != requested {
			return fmt.Errorf("surface caller %q cannot access %q", caller, requested)
		}
		return nil
	}
	if mainID == 0 || callerID != mainID {
		return fmt.Errorf("unknown view cannot access surface %q", requested)
	}
	return nil
}

func (s *Surfaces) authorizeSurface(viewID uint64, requested string) error {
	if s.window == nil {
		return fmt.Errorf("window is not available")
	}
	return AuthorizeSurfaceCaller(s.surfaceOf(viewID), requested, viewID, uint64(s.window.ID()))
}

// exposureRegister forwards the registration of a surface page to the main page.
func (s *Surfaces) exposureRegister(viewID uint64, req SurfaceRegistration) error {
	if surface := s.surfaceOf(viewID); surface == "" || surface != req.Surface {
		return fmt.Errorf("this document is not surface %q", req.Surface)
	}
	if req.Kind != "status" && req.Kind != "command" && req.Kind != "dom" {
		return fmt.Errorf("unknown exposure kind %q", req.Kind)
	}
	// The only core names that a surface registers are core.surface.* (docs/spec/exposure.md).
	core := strings.HasPrefix(req.Name, "core.") && !strings.HasPrefix(req.Name, "core.surface.")
	if !namePattern.MatchString(req.Name) || isHostName(req.Name) || core {
		return fmt.Errorf("a surface cannot register %q", req.Name)
	}
	s.mu.Lock()
	if s.registrations == nil {
		s.registrations = map[string][]SurfaceRegistration{}
	}
	known := false
	for _, previous := range s.registrations[req.Surface] {
		known = known || previous == req
	}
	if !known {
		s.registrations[req.Surface] = append(s.registrations[req.Surface], req)
	}
	s.mu.Unlock()
	s.window.EmitEvent("exposure-registered", req)
	return nil
}

// replayRegistrations announces the registrations of surface pages again to a main page that was read again. A surface remains even when the main
// page is read again, so the new page receives through this call the registrations that the previous page received.
func (s *Surfaces) replayRegistrations() {
	s.mu.Lock()
	var all []SurfaceRegistration
	for _, list := range s.registrations {
		all = append(all, list...)
	}
	s.mu.Unlock()
	for _, req := range all {
		s.window.EmitEvent("exposure-registered", req)
	}
}

// reloadPage makes the main page read again in the same WebContent process and waits until the new page reports that it is ready.
// A ready page first finishes the pending save (docs/spec/projects.md#persistence). WebKit keeps the previous page on the screen until the new page first draws visible
// content, and the start document request of the new page cleans up the previous page
// (docs/spec/native-host.md#page-start).
func (s *Surfaces) reloadPage() error {
	s.host.mu.Lock()
	pageReady := s.ready
	s.host.mu.Unlock()
	if pageReady {
		flush := map[string]any{"name": "core.projects.flush", "params": map[string]any{}}
		if _, err := s.host.ask(s, "command.run", flush, pageTimeout); err != nil {
			return err
		}
	}
	ready := make(chan struct{})
	s.host.mu.Lock()
	s.readied = append(s.readied, ready)
	s.host.mu.Unlock()
	if pageReady {
		// A ready page reads again by itself after all calls it sent received a reply. When the host reads again, the reply that was being
		// written at that moment is lost (docs/spec/native-host.md#page-reload).
		s.window.EmitEvent("page-reload")
	} else {
		application.InvokeSync(func() { s.window.Reload() })
	}
	select {
	case <-ready:
		return nil
	case <-time.After(pageTimeout):
		return rpcError(codeTimeout, "%s", ReloadTimeoutText(pageTimeout, runningCalls.Of(s.window.Name(), time.Now())))
	}
}

// exposureReply receives the reply that a surface page sent to a forwarded request.
// surfacesClosed announces the unregistration of removed surfaces to the main page and ends the requests sent to those surfaces.
func (s *Surfaces) surfacesClosed(ids []string) {
	if len(ids) == 0 {
		return
	}
	closed := map[string]bool{}
	s.mu.Lock()
	for _, id := range ids {
		delete(s.registrations, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		closed[id] = true
		s.window.EmitEvent("exposure-registered", map[string]any{"surface": id, "closed": true})
	}
	s.host.relay.Abandon(func(t relayTarget) bool { return t.owner == s && closed[t.surface] })
}

// byName returns the window with the name name.
func (h *Host) byName(name string) *Surfaces {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.windows {
		if s.name == name {
			return s
		}
	}
	return nil
}

// hostBackend provides windows and pages to the endpoint. The public methods of Host are bound to the page, so
// these methods are placed in a separate type.
type hostBackend struct{ h *Host }

func (b hostBackend) Windows() []WindowEntry {
	b.h.mu.Lock()
	windows := make([]*Surfaces, 0, len(b.h.windows))
	ready := map[*Surfaces]bool{}
	for _, s := range b.h.windows {
		windows = append(windows, s)
		ready[s] = s.ready
	}
	b.h.mu.Unlock()
	out := make([]WindowEntry, 0, len(windows))
	for _, s := range windows {
		s.mu.Lock()
		entry := WindowEntry{Window: s.name, Title: s.title, Ready: ready[s]}
		if s.root != "" {
			root := s.root
			entry.Project = &root
		}
		s.mu.Unlock()
		entry.Key = s.window.IsFocused()
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Window < out[j].Window })
	return out
}

func (b hostBackend) HasWindow(window string) bool { return b.h.byName(window) != nil }

func (b hostBackend) window(name string) (*Surfaces, error) {
	s := b.h.byName(name)
	if s == nil {
		return nil, errMissingWindow(name)
	}
	return s, nil
}

func (b hostBackend) PageRequest(window, method string, params json.RawMessage) (json.RawMessage, error) {
	s, err := b.window(window)
	if err != nil {
		return nil, err
	}
	// The main page finishes a command forwarded to a surface within the time limit of the declaration, so command.run has no limit.
	timeout := pageTimeout
	if method == "command.run" {
		timeout = 0
	}
	return b.h.ask(s, method, params, timeout)
}

func (b hostBackend) HostStatus(window, name string) (any, error) {
	s, err := b.window(window)
	if err != nil {
		return nil, err
	}
	switch name {
	case "host.screens":
		return screens()
	case "host.dock":
		return dockItems()
	case "host.menu":
		return menuItems()
	case "host.windows":
		return b.Windows(), nil
	case "host.sidecars":
		return b.sidecarsState(), nil
	case "host.buttons":
		return b.h.buttons.Value(), nil
	case "host.log":
		if b.h.logNotices == nil {
			return nil, fmt.Errorf("the log notices are not started")
		}
		return b.h.logNotices.Value(), nil
	}
	return s.windowState()
}

func (b hostBackend) HostCommand(window, name string, params json.RawMessage) (any, error) {
	s, err := b.window(window)
	if err != nil {
		return nil, err
	}
	switch name {
	case "host.window.close":
		s.window.Close()
	case "host.window.maximize":
		var p struct {
			On *bool `json:"on"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, rpcError(codeInvalidParams, "%v", err)
		}
		if p.On == nil || *p.On {
			s.window.Maximise()
		} else {
			s.window.UnMaximise()
		}
	case "host.window.fullscreen":
		var p struct {
			On *bool `json:"on"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, rpcError(codeInvalidParams, "%v", err)
		}
		return nil, s.fullscreen(p.On == nil || *p.On)
	case "host.window.resize":
		var p struct {
			Width, Height *float64
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, rpcError(codeInvalidParams, "%v", err)
		}
		if p.Width == nil || p.Height == nil || *p.Width < 1 || *p.Height < 1 {
			return nil, rpcError(codeInvalidParams, "width and height must be positive numbers")
		}
		s.window.SetSize(int(*p.Width), int(*p.Height))
	case "host.window.move":
		var p struct {
			X, Y *float64
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, rpcError(codeInvalidParams, "%v", err)
		}
		if p.X == nil || p.Y == nil {
			return nil, rpcError(codeInvalidParams, "x and y are required")
		}
		return nil, s.useWindow(func(window unsafe.Pointer) error { return system.MoveWindow(window, *p.X, *p.Y) })
	case "host.menu.select":
		var p struct {
			Menu, Title *string
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, rpcError(codeInvalidParams, "%v", err)
		}
		if p.Menu == nil || p.Title == nil {
			return nil, rpcError(codeInvalidParams, "menu and title are required")
		}
		var selected error
		application.InvokeSync(func() { selected = system.MenuSelect(*p.Menu, *p.Title) })
		return nil, selected
	case "host.dock.select":
		var p struct {
			Title *string
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, rpcError(codeInvalidParams, "%v", err)
		}
		if p.Title == nil {
			return nil, rpcError(codeInvalidParams, "title is required")
		}
		var selected error
		application.InvokeSync(func() { selected = system.DockSelect(*p.Title) })
		return nil, selected
	case "host.window.reload":
		return nil, s.reloadPage()
	case "host.window.presented":
		displayed, err := s.presented()
		if err != nil {
			return nil, err
		}
		return map[string]float64{"displayed": displayed}, nil
	case "host.hit":
		var p struct {
			X, Y *float64
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, rpcError(codeInvalidParams, "%v", err)
		}
		if p.X == nil || p.Y == nil {
			return nil, rpcError(codeInvalidParams, "x and y are required")
		}
		return s.hit(*p.X, *p.Y)
	case "host.quit":
		routine.Go("quit", application.Get().Quit)
	default:
		return nil, rpcError(codeUnknownName, "unknown command %s", name)
	}
	return nil, nil
}

var pointerPhaseCodes = map[string]int{"move": 0, "down": 1, "drag": 2, "up": 3, "scroll": 4}

// receiveTimeout is the time that the press and release of input.pointer wait for a document to receive them.
const receiveTimeout = 2 * time.Second

// activateTimeout is the time that the activate of input.pointer waits for activation.
const activateTimeout = 5 * time.Second

// errInactive is the error for the case in which the window is not the key window and the move could not be delivered.
func errInactive() *RPCError { return rpcError(codeInactive, "the window is not active") }

// delivered converts the result of a native key input to an endpoint error.
func delivered(ok bool, err error) error {
	if err != nil {
		return rpcError(codeNoInput, "%v", err)
	}
	if !ok {
		return rpcError(codeInvalidParams, "the window did not accept the key: the key name is unknown")
	}
	return nil
}

func (b hostBackend) Pointer(window string, input PointerInput) error {
	s, err := b.window(window)
	if err != nil {
		return err
	}
	if input.Activate {
		if err := s.activate(input.X, input.Y); err != nil {
			return err
		}
	}
	button := 0
	if input.Button == "right" {
		button = 1
	}
	type delivery struct {
		result platform.PointerResult
		held   platform.ButtonHeld
	}
	done := make(chan delivery, 1)
	err = s.useWindow(func(window unsafe.Pointer) error {
		return system.InjectPointer(window, input.X, input.Y, pointerPhaseCodes[input.Phase], button,
			input.DeltaX, input.DeltaY, receiveTimeout.Seconds(), func(result platform.PointerResult, held platform.ButtonHeld) {
				done <- delivery{result, held}
			})
	})
	if err != nil {
		return nativeError(codeNoInput, err)
	}
	got := <-done
	switch got.result {
	case platform.PointerInactive:
		return errInactive()
	case platform.PointerRejected:
		return rpcError(codeInvalidParams, "the window did not accept the input")
	case platform.PointerUnreceived:
		return rpcError(codeTimeout, "the document did not receive the input within %s", receiveTimeout)
	case platform.PointerButtonHeld:
		return rpcError(codeButtonHeld, "%s", ButtonHeldMessage(got.held))
	case platform.PointerPressOpen:
		return rpcError(codePressOpen, "a synthetic press of this button is still open in the window; send up before the next down")
	}
	if input.Phase == "down" {
		if err := s.pressAt(input.X, input.Y); err != nil {
			return nativeError(codeNoInput, err)
		}
	}
	return nil
}

// ButtonHeldMessage builds the message of the 1007 error. It writes the mask at the time of the rejection and the frontmost application
// (docs/spec/exposure.md).
func ButtonHeldMessage(held platform.ButtonHeld) string {
	frontmost := "no application"
	if f := held.Frontmost; f != nil {
		if f.BundleIdentifier == "" {
			frontmost = fmt.Sprintf("an application without a bundle identifier (pid %d)", f.PID)
		} else {
			frontmost = fmt.Sprintf("%s (pid %d)", f.BundleIdentifier, f.PID)
		}
	}
	return fmt.Sprintf("AppKit reports NSEvent.pressedMouseButtons mask %#x while %s is frontmost; the synthetic press or release was not delivered",
		held.Mask, frontmost)
}

// activate activates the application, makes the window the key window, and waits until the web view of the window receives the active state.
// When activation does not finish, it returns a 1006 error that names the stage where it stopped.
func (s *Surfaces) activate(x, y float64) error {
	done := make(chan error, 1)
	err := s.useWindow(func(window unsafe.Pointer) error {
		return system.ActivateWindow(window, x, y, activateTimeout.Seconds(), func(result error) { done <- result })
	})
	if err != nil {
		return nativeError(codeNoInput, err)
	}
	if err := <-done; err != nil {
		return rpcError(codeInactive, "%v", err)
	}
	return nil
}

func (b hostBackend) Key(window string, input KeyInput) error {
	s, err := b.window(window)
	if err != nil {
		return err
	}
	var result platform.PointerResult
	err = s.useWindow(func(window unsafe.Pointer) error {
		var injected error
		result, injected = system.InjectKey(window, input.Key, input.Text, input.Modifiers, input.Down)
		return injected
	})
	if err != nil {
		return nativeError(codeNoInput, err)
	}
	if result == platform.PointerInactive {
		return rpcError(codeInactive, "keys reach only the key window of the active application")
	}
	return delivered(result == platform.PointerDelivered, nil)
}

// native reads the native JSON with read on the UI thread and puts it into into. inspect runs after the read in the same UI thread
// task.
func native(read func() (string, error), into any, inspect func()) error {
	var text string
	var err error
	application.InvokeSync(func() {
		text, err = read()
		if err == nil && inspect != nil {
			inspect()
		}
	})
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(text), into)
}

// nativeFacts puts into into the native JSON that read read from the native window of this window in one step of the UI thread.
// inspect runs after the read in the same step. A window that closed before that step gives 1003.
func (s *Surfaces) nativeFacts(read func(window unsafe.Pointer) (string, error), into any, inspect func()) error {
	var text string
	err := s.useWindow(func(window unsafe.Pointer) error {
		var err error
		text, err = read(window)
		if err == nil && inspect != nil {
			inspect()
		}
		return err
	})
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(text), into)
}

// frame is {x, y, width, height}.
type frame struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// point is one point in screen coordinates.
type point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// windowFacts is the result of sp_window_facts of native/darwin.
type windowFacts struct {
	Responder struct {
		Class   string `json:"class"`
		Webview uint64 `json:"webview"`
		Surface uint64 `json:"surface"`
		Main    bool   `json:"main"`
	} `json:"responder"`
	Main    uint64 `json:"main"`
	Frame   frame  `json:"frame"`
	Pointer point  `json:"pointer"`
	Content struct {
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	} `json:"content"`
	Scale       float64         `json:"scale"`
	RefreshRate *int            `json:"refreshRate"`
	Zoomed      bool            `json:"zoomed"`
	Key         bool            `json:"key"`
	Active      bool            `json:"active"`
	Occluded    bool            `json:"occluded"`
	Children    int             `json:"children"`
	PageProcess int             `json:"pageProcess"`
	Controls    []WindowControl `json:"controls"`
	Webviews    []struct {
		frame
		View     uint64  `json:"view"`
		Hidden   bool    `json:"hidden"`
		Focused  bool    `json:"focused"`
		Main     bool    `json:"main"`
		Document bool    `json:"document"`
		Draws    bool    `json:"draws"`
		Alpha    float64 `json:"alpha"`
	} `json:"webviews"`
	NativeSurfaces []struct {
		frame
		View   uint64 `json:"view"`
		Hidden bool   `json:"hidden"`
	} `json:"nativeSurfaces"`
	AppDomWebviews   int `json:"appDomWebviews"`
	DocumentWebviews int `json:"documentWebviews"`
}

// WindowSurface is one surface of host.window.
type WindowSurface struct {
	ID      string `json:"id"`
	Frame   frame  `json:"frame"`
	Visible bool   `json:"visible"`
	Order   int    `json:"order"`
}

// WindowDocument is one document region of host.window.
type WindowDocument struct {
	Surface  string `json:"surface"`
	Document string `json:"document"`
	Frame    frame  `json:"frame"`
	Visible  bool   `json:"visible"`
	Focused  bool   `json:"focused"`
	Order    int    `json:"order"`
}

// WindowWebview is the frame of one web view in the window coordinate system.
type WindowWebview struct {
	Frame    frame `json:"frame"`
	Main     bool  `json:"main"`
	Document bool  `json:"document"`
	Visible  bool  `json:"visible"`
	Focused  bool  `json:"focused"`
	Order    int   `json:"order"`
}

// ModalBackground is the background drawing state of a modal web view.
type ModalBackground struct {
	Draws bool    `json:"draws"`
	Alpha float64 `json:"alpha"`
}

// WindowModal is an open modal of host.window. When the view does not exist yet, Frame, Order and Background are null.
type WindowModal struct {
	ID         string           `json:"id"`
	Mode       string           `json:"mode"`
	Shown      bool             `json:"shown"`
	Frame      *frame           `json:"frame"`
	Order      *int             `json:"order"`
	Background *ModalBackground `json:"background"`
}

// WindowControl is the region of one window button.
type WindowControl struct {
	frame
	Hidden bool `json:"hidden"`
}

// WindowRegion is one image region of host.window.
type WindowRegion struct {
	Surface   string `json:"surface"`
	Name      string `json:"name"`
	Frame     frame  `json:"frame"`
	Visible   bool   `json:"visible"`
	Focused   bool   `json:"focused"`
	Presented *struct {
		Width      int     `json:"width"`
		Height     int     `json:"height"`
		Scale      float64 `json:"scale"`
		Generation uint64  `json:"generation"`
		Raster     uint64  `json:"raster"`
		Sequence   int     `json:"sequence"`
	} `json:"presented"`
	Layer struct {
		Bounds        frame   `json:"bounds"`
		ContentsScale float64 `json:"contentsScale"`
	} `json:"layer"`
	Error *string `json:"error"`
}

// WindowResponder is the first responder of the window. Owner is the kind of web view that contains it, one of page, surface,
// document, modal, webview, and native. webview is a web view that is not registered, and native is a view outside
// the web views (for example an image region). Surface is the surface that contains the first responder.
type WindowResponder struct {
	Class    string  `json:"class"`
	Owner    string  `json:"owner"`
	Surface  *string `json:"surface"`
	Document *string `json:"document"`
}

// WindowStatus is the value of host.window.
type WindowStatus struct {
	Responder        WindowResponder  `json:"responder"`
	Frame            frame            `json:"frame"`
	Pointer          point            `json:"pointer"`
	Content          frame            `json:"content"`
	Scale            float64          `json:"scale"`
	RefreshRate      *int             `json:"refreshRate"`
	Maximized        bool             `json:"maximized"`
	Key              bool             `json:"key"`
	Active           bool             `json:"active"`
	Occluded         bool             `json:"occluded"`
	Children         int              `json:"children"`
	PageProcess      int              `json:"pageProcess"`
	Quitting         bool             `json:"quitting"`
	AppDomWebviews   int              `json:"appDomWebviews"`
	DocumentWebviews int              `json:"documentWebviews"`
	Controls         []WindowControl  `json:"controls"`
	Webviews         []WindowWebview  `json:"webviews"`
	Surfaces         []WindowSurface  `json:"surfaces"`
	Documents        []WindowDocument `json:"documents"`
	Regions          []WindowRegion   `json:"regions"`
	Modal            *WindowModal     `json:"modal"`
}

// viewNames reads, on the UI thread, the ids of the surface web views and the addresses of the modal web views.
func (s *Surfaces) viewNames() (named map[uint64]string) {
	named = map[uint64]string{}
	for view, id := range s.named {
		named[uint64(view)] = id
	}
	return named
}

// windowState reads the current value of host.window.
func (s *Surfaces) windowState() (WindowStatus, error) {
	var facts windowFacts
	var named map[uint64]string
	var documents map[uint64]DocumentKey
	regions := []WindowRegion{}
	err := s.nativeFacts(func(window unsafe.Pointer) (string, error) {
		named = s.viewNames()
		documents = s.documents.Names()
		for _, key := range s.images.Names() {
			handle, err := s.images.Get(key)
			if err != nil {
				return "", err
			}
			text, err := system.FactsImage(handle)
			if err != nil {
				return "", fmt.Errorf("image %s/%s: %w", key.Surface, key.Name, err)
			}
			region := WindowRegion{Surface: key.Surface, Name: key.Name}
			if err := json.Unmarshal([]byte(text), &region); err != nil {
				return "", fmt.Errorf("image %s/%s facts: %w", key.Surface, key.Name, err)
			}
			// presented is the size of the presented image with the identity of the frame that the host marked presented; null while no frame of the current raster is presented.
			if presented, ok := s.images.PresentedFrame(key); ok && region.Presented != nil {
				region.Presented.Generation = presented.Generation
				region.Presented.Raster = presented.Raster
				region.Presented.Sequence = presented.Sequence
			} else {
				region.Presented = nil
			}
			regions = append(regions, region)
		}
		return system.WindowFacts(window)
	}, &facts, nil)
	if err != nil {
		return WindowStatus{}, err
	}
	out := WindowStatus{
		Frame: facts.Frame, Pointer: facts.Pointer, Content: frame{Width: facts.Content.Width, Height: facts.Content.Height},
		Scale: facts.Scale, RefreshRate: facts.RefreshRate, Maximized: facts.Zoomed, Key: facts.Key, Active: facts.Active, Occluded: facts.Occluded, Children: facts.Children,
		PageProcess: facts.PageProcess, Quitting: s.host.quit.Active(),
		Controls: facts.Controls, Surfaces: []WindowSurface{}, Documents: []WindowDocument{}, Regions: regions,
		Webviews: []WindowWebview{},
	}
	out.DocumentWebviews = facts.DocumentWebviews
	out.AppDomWebviews = facts.AppDomWebviews
	if out.Controls == nil {
		out.Controls = []WindowControl{}
	}
	var modal *WindowModal
	var modalHandle uint64
	s.mu.Lock()
	if s.modal != nil {
		modal = &WindowModal{ID: s.modal.id, Mode: s.modal.content.Mode, Shown: s.modal.visible}
		if s.modal.view != nil {
			modalHandle = uint64(uintptr(s.modal.view.handle))
		}
		if s.modal.view != nil && s.modal.visible {
			modalView := uint64(uintptr(s.modal.view.handle))
			found := false
			for _, view := range facts.Webviews {
				if view.View != modalView {
					continue
				}
				frame := view.frame
				modal.Frame = &frame
				modalOrder := len(facts.NativeSurfaces) + len(facts.Webviews)
				modal.Order = &modalOrder
				modal.Background = &ModalBackground{Draws: view.Draws, Alpha: view.Alpha}
				found = true
				break
			}
			if !found {
				s.mu.Unlock()
				return WindowStatus{}, fmt.Errorf("visible modal webview %d is absent from window facts", modalView)
			}
		}
	}
	s.mu.Unlock()
	if facts.NativeSurfaces == nil {
		return WindowStatus{}, fmt.Errorf("window facts missing nativeSurfaces")
	}
	for order, view := range facts.NativeSurfaces {
		id, ok := named[view.View]
		if !ok {
			return WindowStatus{}, fmt.Errorf("unregistered native surface %d", view.View)
		}
		out.Surfaces = append(out.Surfaces, WindowSurface{ID: id, Frame: view.frame, Visible: !view.Hidden, Order: order})
	}
	for order, view := range facts.Webviews {
		out.Webviews = append(out.Webviews, WindowWebview{Frame: view.frame, Main: view.Main,
			Document: view.Document, Visible: !view.Hidden, Focused: view.Focused, Order: order})
		if key, ok := documents[view.View]; ok {
			out.Documents = append(out.Documents, WindowDocument{Surface: key.Surface, Document: key.Name,
				Frame: view.frame, Visible: !view.Hidden, Focused: view.Focused, Order: order})
		}
	}
	out.Responder = WindowResponder{Class: facts.Responder.Class, Owner: "native"}
	if id, ok := named[facts.Responder.Surface]; ok && facts.Responder.Surface != 0 {
		out.Responder.Surface = &id
	}
	if view := facts.Responder.Webview; view != 0 {
		key, document := documents[view]
		switch {
		case document:
			out.Responder.Owner, out.Responder.Surface, out.Responder.Document = "document", &key.Surface, &key.Name
		case out.Responder.Surface != nil:
			out.Responder.Owner = "surface"
		case modalHandle != 0 && modalHandle == view:
			out.Responder.Owner = "modal"
		case facts.Responder.Main:
			out.Responder.Owner = "page"
		default:
			out.Responder.Owner = "webview"
		}
	}
	sort.Slice(out.Regions, func(a, b int) bool {
		if out.Regions[a].Surface != out.Regions[b].Surface {
			return out.Regions[a].Surface < out.Regions[b].Surface
		}
		return out.Regions[a].Name < out.Regions[b].Name
	})
	out.Modal = modal
	return out, nil
}

// screens reads the current value of host.screens.
func screens() (any, error) {
	var out []map[string]any
	if err := native(system.Screens, &out, nil); err != nil {
		return nil, err
	}
	return out, nil
}

// menuItems reads the current value of host.menu. language is the menu language that the host manages and
// menus are the configured menus. The language is the state of the host itself and is not a value inferred from the menu titles.
func menuItems() (any, error) {
	var menus []any
	if err := native(system.MenuItems, &menus, nil); err != nil {
		return nil, err
	}
	return map[string]any{"language": currentMenuLanguage(), "menus": menus}, nil
}

// dockItems reads the current value of host.dock.
func dockItems() (any, error) {
	var out []string
	if err := native(system.DockItems, &out, nil); err != nil {
		return nil, err
	}
	return out, nil
}

// hit returns the owner at the window coordinates (x, y).
func (s *Surfaces) hit(x, y float64) (map[string]any, error) {
	var got struct {
		View       uint64 `json:"view"`
		Main       bool   `json:"main"`
		Identifier string `json:"identifier"`
		Hit        *struct {
			Class string `json:"class"`
			Frame frame  `json:"frame"`
		} `json:"hit"`
	}
	var documents map[uint64]DocumentKey
	err := s.nativeFacts(func(window unsafe.Pointer) (string, error) { return system.WindowHit(window, x, y) }, &got, func() {
		documents = s.documents.Names()
	})
	if err != nil {
		return nil, err
	}
	switch {
	case got.View != 0 && documents[got.View].Surface != "":
		key := documents[got.View]
		return map[string]any{"kind": "document", "surface": key.Surface, "document": key.Name}, nil
	case got.Main:
		return map[string]any{"kind": "page"}, nil
	default:
		return map[string]any{"kind": "native", "identifier": got.Identifier, "view": got.Hit}, nil
	}
}

// fullscreen switches the window to full screen or back and returns after the transition ends. macOS ignores a request during a
// transition, so the native code continues the handling after that transition ends.
func (s *Surfaces) fullscreen(on bool) error {
	done := make(chan struct{}, 1)
	err := s.useWindow(func(window unsafe.Pointer) error {
		return system.Fullscreen(window, on, func() { done <- struct{}{} })
	})
	if err != nil {
		return err
	}
	select {
	case <-done:
		return nil
	case <-time.After(pageTimeout):
		return rpcError(codeTimeout, "the window did not change full screen within %s", pageTimeout)
	}
}

// presented waits until the surface layout transaction of the window and the current picture raster are fixed and the main page and the visible app document
// display that layout, and returns the time (ms, mach absolute time) at which that screen is displayed.
func (s *Surfaces) presented() (float64, error) {
	deadline := time.Now().Add(pageTimeout)
	waitFrame := func() (float64, error) {
		done := make(chan struct {
			displayed float64
			err       error
		}, 1)
		var err error
		application.InvokeSync(func() {
			err = system.AfterSettled(s.window.NativeWindow(), func(displayed float64, callbackErr error) {
				done <- struct {
					displayed float64
					err       error
				}{displayed: displayed, err: callbackErr}
			})
		})
		if err != nil {
			return 0, err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return 0, rpcError(codeTimeout, "the window did not present within %s", pageTimeout)
		}
		select {
		case result := <-done:
			if result.err != nil {
				return 0, result.err
			}
			return result.displayed, nil
		case <-time.After(remaining):
			return 0, rpcError(codeTimeout, "the window did not present within %s", pageTimeout)
		}
	}

	if _, err := waitFrame(); err != nil {
		return 0, err
	}
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return 0, rpcError(codeTimeout, "the current image raster did not present within %s; pending %s",
				pageTimeout, s.images.PendingRasters())
		}
		// Instrument of the display barrier wait (V5-104): when this wait hits the timeout, the screen is stopped.
		barrierStarted := time.Now()
		barrierErr := s.images.WaitCurrentError(remaining)
		PerformanceObserve("host", func() map[string]any {
			return map[string]any{
				"event": "barrier", "wait_us": time.Since(barrierStarted).Microseconds(),
				"ok": barrierErr == nil,
			}
		})
		if err := barrierErr; err != nil {
			if err.Error() == "presentationTimeout" {
				return 0, rpcError(codeTimeout, "the current image raster did not present within %s; pending %s",
					pageTimeout, s.images.PendingRasters())
			}
			return 0, rpcError(codeHandler, "the current image raster failed to present: %v", err)
		}
		displayed, err := waitFrame()
		if err != nil {
			return 0, err
		}
		if s.images.CurrentPresented() {
			return displayed, nil
		}
	}
}

// windowsChanged sends the window list to the connections that watch host.windows. The value is the result of windows.list, and
// it is called when a window opens or closes or when a title, a project, or the key state changes.
// sidecarsState is the current value of host.sidecars.
func (b hostBackend) sidecarsState() map[string]any {
	closing := []ClosingSurface{}
	outdated := []OutdatedSidecar{}
	if b.h.sidecars != nil {
		closing = b.h.sidecars.Closing()
		outdated = b.h.sidecars.Outdated()
	}
	return map[string]any{"closing": closing, "outdated": outdated}
}

// sidecarsChanged sends the new value to the connections that watch host.sidecars.
func (h *Host) sidecarsChanged() {
	h.notifySidecars()
	if h.endpoint == nil {
		return
	}
	backend := hostBackend{h}
	value := backend.sidecarsState()
	for _, entry := range backend.Windows() {
		if h.endpoint.Watching(entry.Window, "host.sidecars") {
			h.endpoint.StatusChanged(entry.Window, "host.sidecars", "", value)
		}
	}
}

func (h *Host) windowsChanged() {
	if h.endpoint == nil {
		return
	}
	list := hostBackend{h}.Windows()
	for _, entry := range list {
		if h.endpoint.Watching(entry.Window, "host.windows") {
			h.endpoint.StatusChanged(entry.Window, "host.windows", "", list)
		}
	}
}

// windowChanged sends the new value to the connections that watch host.window. When no connection watches, it does not
// read the value. It is also called on the UI thread, so the value is read in another goroutine.
func (s *Surfaces) windowChanged() {
	if s.host == nil || s.host.endpoint == nil || !s.host.endpoint.Watching(s.name, "host.window") {
		return
	}
	routine.Go("window-status", func() {
		state, err := s.windowState()
		var coded *RPCError
		if errors.As(err, &coded) && coded.Code == codeNoWindow {
			// A window that closed before the status was read has no status to announce.
			return
		}
		if err != nil {
			s.fail("host.window", err)
			return
		}
		s.host.endpoint.StatusChanged(s.name, "host.window", "", state)
	})
}

// rewatch requests the watches and diagnostic subscriptions of this window again from the reloaded main page.
func (s *Surfaces) rewatch() {
	if s.host == nil || s.host.endpoint == nil {
		return
	}
	for _, t := range s.host.endpoint.topics(s.name) {
		var err error
		request, diagnostic := diagnosticTopics[t.name]
		switch {
		case diagnostic:
			method, params := request(true)
			_, err = s.host.ask(s, method, params, pageTimeout)
		case !isHostName(t.name):
			params := map[string]any{}
			for key, value := range t.watchParams() {
				params[key] = value
			}
			_, err = s.host.ask(s, "status.watch", params, pageTimeout)
		}
		if err != nil {
			s.fail("rewatch "+t.name, err)
		}
	}
}

// note writes one line of the diagnostic transcript to the application log and also sends it to the connections that enabled the diagnostic transcript.
func (s *Surfaces) note(line string) {
	Log(TranscriptEntry(s.name, line))
	s.log(line)
}

// fail writes an error that the diagnostic transcript carries to the application log and also sends it to the connections that enabled the diagnostic transcript.
func (s *Surfaces) fail(where string, err error) {
	Log(TranscriptFailure(s.name, where, err))
	s.log(fmt.Sprintf("%s: %v", where, err))
}

// log sends one line to the connections that enabled the diagnostic transcript of this window. A build that is not a diagnostic build has no destination.
func (s *Surfaces) log(line string) {
	if transcribe != nil && s.host != nil && s.host.endpoint != nil {
		transcribe(s.host.endpoint, s.name, line)
	}
}
