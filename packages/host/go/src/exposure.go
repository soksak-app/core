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
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

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
		Description: "Window frame and system pointer location in screen coordinates, content size, backing scale, the maximum refresh rate of its screen (null when the window is on no screen), maximized, key and application active state, whether other windows cover the whole window, child window count, the WebContent process of the app page (0 before it starts), the WebContent processes that held a page of the application and hold none while they live, with whether WebKit ends each (null on a platform that does not report them), whether the application is quitting, window buttons, webview frames, native surfaces, document regions, image regions with the number of frames that the host marked presented for each, the open native modal, and the frames and command buffers of the workbench and whether it settled after its last frame, null on a host whose workbench WebKit draws.",
		Schema: map[string]any{"type": "object", "properties": map[string]any{
			"frame":       rectSchema,
			"pointer":     map[string]any{"type": "object", "properties": map[string]any{"x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"}}},
			"content":     rectSchema,
			"scale":       map[string]any{"type": "number"},
			"refreshRate": map[string]any{"type": []string{"integer", "null"}},
			"pageProcess": map[string]any{"type": []any{"integer", "null"}},
			"quitting":    map[string]any{"type": "boolean"},
			"maximized":   map[string]any{"type": "boolean"},
			"key":         map[string]any{"type": "boolean"},
			"virtualKey":  map[string]any{"type": "boolean"},
			"cursor":      map[string]any{"type": []string{"string", "null"}},
			"active":      map[string]any{"type": "boolean"},
			"activationObservation": map[string]any{"type": "object", "required": []string{"registered", "count"}, "properties": map[string]any{
				"registered": map[string]any{"type": "boolean"},
				"count":      map[string]any{"type": "string", "pattern": "^(0|[1-9][0-9]*)$"},
			}},
			"occluded": map[string]any{"type": "boolean"},
			"display":  map[string]any{"type": []string{"integer", "null"}},
			"order": map[string]any{"type": []string{"object", "null"}, "required": []string{"index", "count", "otherInFront"},
				"properties": map[string]any{
					"index": map[string]any{"type": "integer"}, "count": map[string]any{"type": "integer"},
					"otherInFront": map[string]any{"type": "boolean"},
				}},
			"children": map[string]any{"type": "integer"},
			"pagelessProcesses": map[string]any{"type": []string{"array", "null"}, "items": map[string]any{"type": "object",
				"required": []string{"pid", "ending"}, "properties": map[string]any{
					"pid": map[string]any{"type": "integer"}, "ending": map[string]any{"type": "boolean"},
				}}},
			"controls": map[string]any{"type": "array", "items": rectSchema},
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
				"process": map[string]any{"type": "integer"}, "blurred": map[string]any{"type": "boolean"},
			}}},
			"regions": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"surface": map[string]any{"type": "string"}, "name": map[string]any{"type": "string"},
				"frame": rectSchema, "visible": map[string]any{"type": "boolean"}, "drawing": map[string]any{"type": "boolean"},
				"focused": map[string]any{"type": "boolean"}, "blurred": map[string]any{"type": "boolean"},
				"presented": map[string]any{"type": []any{"object", "null"}, "properties": map[string]any{
					"sequence": map[string]any{"type": "integer"}, "generation": map[string]any{"type": "integer"}, "raster": map[string]any{"type": "integer"},
					"width": map[string]any{"type": "integer"}, "height": map[string]any{"type": "integer"}, "scale": map[string]any{"type": "number"},
				}},
				"presentedFrames": map[string]any{"type": "integer"},
				"error":           map[string]any{"type": []any{"string", "null"}},
			}}},
			"frames":         map[string]any{"type": []any{"integer", "null"}},
			"commandBuffers": map[string]any{"type": []any{"integer", "null"}},
			"settled":        map[string]any{"type": []any{"boolean", "null"}},
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
		Description: "The surfaces whose closed the host has sent and the sidecar has not answered, sorted by sidecar and surface, and the persistent sidecars whose service runs another version than the installed one, sorted by sidecar, with the running version (null when the service sent none), the installed version (null when the sidecar is no longer declared) and the number of open surfaces of the service: {closing: [{sidecar, surface}], outdated: [{sidecar, running, installed, sessions}]}.",
		Schema: map[string]any{"type": "object", "properties": map[string]any{
			"closing": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"sidecar": map[string]any{"type": "string"}, "surface": map[string]any{"type": "string"},
			}}},
			"outdated": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"sidecar": map[string]any{"type": "string"}, "running": map[string]any{"type": []any{"string", "null"}},
				"installed": map[string]any{"type": []any{"string", "null"}}, "sessions": map[string]any{"type": "integer"},
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
	"host.window.raise": {Description: "Orders the window in front of every window of its level, also of other applications, without activating the application.", Params: emptyObject, Result: nullSchema},
	"host.window.lower": {Description: "Orders the window behind every window of its level, also of other applications, without changing the active application.", Params: emptyObject, Result: nullSchema},
	"host.menu.select": {Description: "Performs the application menu item with the title in the submenu with the menu title.", Result: nullSchema,
		Params: map[string]any{"type": "object", "properties": map[string]any{
			"menu": map[string]any{"type": "string"}, "title": map[string]any{"type": "string"}}}},
	"host.dock.select": {Description: "Performs the Dock menu item with the title.", Result: nullSchema,
		Params: map[string]any{"type": "object", "properties": map[string]any{"title": map[string]any{"type": "string"}}}},
	"host.window.reload":    {Description: "Starts the workbench of the window again.", Params: emptyObject, Result: nullSchema},
	"host.window.presented": {Description: "Resolves after the main page and the shown modal have presented their current geometry and every visible image region has presented its exact current raster, with the display time of that frame.", Params: emptyObject, Result: presentedSchema},
	"host.hit": {Description: "Returns the owner and native hit-view class and frame of a point in window coordinates.",
		Params: map[string]any{"type": "object", "properties": map[string]any{
			"x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"}}},
		Result: map[string]any{"type": "object", "properties": map[string]any{
			"kind":       map[string]any{"type": "string", "enum": []string{"workbench", "document", "native"}},
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
// A request has no time limit: it ends by the reply of its document, by the end of that document (Abandon), by the end of the
// endpoint connection that sent it (End or the end of its context), or by the end of its origin request.
type Relay[T comparable] struct {
	mu      sync.Mutex
	next    uint64
	waiting map[uint64]*relayWaiter[T]
	// ended are the recent requests that ended without the reply of their document. A reply to one of them comes after its
	// request ended, so it is an observation; it remembers up to relayEndedLimit of them and discards the oldest.
	ended []relayEnded[T]
}

// relayEndedLimit is the number of ended requests remembered, so that a reply to one of them is an observation.
const relayEndedLimit = 256

type relayEnded[T comparable] struct {
	id     uint64
	target T
}

type relayWaiter[T comparable] struct {
	target T
	// origin is the id of the request that the forward of this request serves, 0 for a request without origin. The end of the
	// origin request ends this request.
	origin uint64
	reply  chan ExposureResult
}

// NewRelay creates an empty relay.
func NewRelay[T comparable]() *Relay[T] {
	return &Relay[T]{waiting: map[uint64]*relayWaiter[T]{}}
}

// Request creates a request id to send to target, sends it with send, and waits for the reply. When send fails, it does not wait and
// returns a 1003 error. It waits for the reply, for Abandon of its document or for End of its id, with no time limit.
func (r *Relay[T]) Request(target T, send func(id uint64) error) ExposureResult {
	return r.request(context.Background(), target, 0, send)
}

// RequestOf is Request for a forward that serves the request origin: it lives only while origin waits. A forward whose origin
// does not wait is not sent and is refused at once with 1003; the end of origin ends a waiting forward with no result.
func (r *Relay[T]) RequestOf(origin uint64, target T, send func(id uint64) error) ExposureResult {
	return r.request(context.Background(), target, origin, send)
}

// request is Request of the endpoint connection ctx: the end of ctx ends the request as End does, and a ctx that already
// ended sends nothing. origin is the request that the request serves, 0 for none.
func (r *Relay[T]) request(ctx context.Context, target T, origin uint64, send func(id uint64) error) ExposureResult {
	if ctx.Err() != nil {
		return ExposureResult{Error: connectionEnded()}
	}
	r.mu.Lock()
	if origin != 0 && r.waiting[origin] == nil {
		r.mu.Unlock()
		return ExposureResult{Error: originEnded(origin)}
	}
	r.next++
	id := r.next
	w := &relayWaiter[T]{target: target, origin: origin, reply: make(chan ExposureResult, 1)}
	r.waiting[id] = w
	r.mu.Unlock()
	if err := send(id); err != nil {
		r.mu.Lock()
		if r.waiting[id] == w {
			delete(r.waiting, id)
			r.endForwardsOf(id)
		}
		r.mu.Unlock()
		return ExposureResult{Error: rpcError(codeNoWindow, "send request %d: %v", id, err)}
	}
	select {
	case reply := <-w.reply:
		return reply
	case <-ctx.Done():
		r.End(id)
		return <-w.reply
	}
}

// connectionEnded is the error of a request whose endpoint connection ended. The connection receives no answer.
func connectionEnded() *RPCError {
	return rpcError(codeHandler, "the endpoint connection of the request ended")
}

// originEnded is the error of a forward whose origin request does not wait.
func originEnded(origin uint64) *RPCError {
	return rpcError(codeNoWindow, "the origin request %d has ended", origin)
}

// Resolve delivers the reply of a request id. A reply from a document other than the one that received the request and a reply
// to a request that the relay does not know are errors; a reply to a request that ended without it is an observation.
func (r *Relay[T]) Resolve(id uint64, from T, reply ExposureResult) error {
	r.mu.Lock()
	w := r.waiting[id]
	if w == nil || w.target != from {
		defer r.mu.Unlock()
		for i, ended := range r.ended {
			if ended.id == id && ended.target == from {
				r.ended = append(r.ended[:i], r.ended[i+1:]...)
				LogInfo("exposure", fmt.Sprintf("exposure reply %d arrived after its request ended", id))
				return nil
			}
		}
		EmitHost(LevelDebug, "host.trace.exposure.unmatched", map[string]any{"id": id, "held": r.heldState(id, from)})
		return fmt.Errorf("exposure reply %d has no matching request", id)
	}
	delete(r.waiting, id)
	r.endForwardsOf(id)
	r.mu.Unlock()
	w.reply <- reply
	return nil
}

// heldState says where the relay keeps the id of a reply from document from that matches no waiting request: under another
// document, as an ended request, or nowhere (host.trace.exposure.unmatched). The caller holds r.mu.
func (r *Relay[T]) heldState(id uint64, from T) string {
	if w := r.waiting[id]; w != nil && w.target != from {
		return "other-target"
	}
	for _, ended := range r.ended {
		if ended.id == id && ended.target == from {
			return "ended"
		}
	}
	return "none"
}

// Abandon answers the requests sent to the documents for which match is true with a 1003 error. A document that disappeared does not reply.
func (r *Relay[T]) Abandon(match func(T) bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, w := range r.waiting {
		if match(w.target) {
			r.endLocked(id, rpcError(codeNoWindow, "the document closed before it replied"))
		}
	}
}

// End ends the request id, whose endpoint connection ended, on the host. The connection receives no answer, and a later reply of
// the document is an observation. A request that already ended is left as it is.
func (r *Relay[T]) End(id uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.waiting[id] != nil {
		r.endLocked(id, connectionEnded())
	}
}

// endLocked ends the waiting request id without the reply of its document: it answers failure, remembers the request for its
// late reply and ends the forwards of the request. The caller holds r.mu.
func (r *Relay[T]) endLocked(id uint64, failure *RPCError) {
	w := r.waiting[id]
	delete(r.waiting, id)
	if len(r.ended) == relayEndedLimit {
		// The oldest entry is forgotten: a late reply to it has no matching request. The loss is counted.
		r.ended = r.ended[1:]
		recordBufferDrop("relay ended requests", 0, fmt.Sprintf("%d requests", relayEndedLimit))
	}
	r.ended = append(r.ended, relayEnded[T]{id: id, target: w.target})
	w.reply <- ExposureResult{Error: failure}
	r.endForwardsOf(id)
}

// endForwardsOf ends each waiting forward whose origin is the request id, which ended. The caller holds r.mu.
func (r *Relay[T]) endForwardsOf(id uint64) {
	for forward, w := range r.waiting {
		if w.origin == id {
			r.endLocked(forward, originEnded(id))
		}
	}
}

// relayTarget is the main document of a window (surface is empty) or a surface document.
type relayTarget struct {
	owner   *Surfaces
	surface string
}

// ask sends a request of the endpoint connection ctx to the main page of window s and waits for the reply, with no time limit: the
// reply, the end of the page or the end of ctx ends it. A page that is not ready cannot receive the request, so it returns 1003. It
// checks readiness after it registers the request, so the request of a page that was read again in between is rejected here or ends
// through Abandon.
func (h *Host) ask(ctx context.Context, s *Surfaces, method string, params any) (json.RawMessage, error) {
	reply := h.relay.request(ctx, relayTarget{owner: s}, 0, func(id uint64) error {
		h.mu.Lock()
		ready := s.ready
		h.mu.Unlock()
		if !ready {
			return errors.New("the main page is not ready")
		}
		s.window.Emit("exposure-request", map[string]any{"id": id, "method": method, "params": params})
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
	from := surface
	if from == "" {
		from = "main"
	}
	EmitHost(LevelDebug, "host.trace.exposure.reply", map[string]any{"id": req.ID, "from": from})
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
	// Origin is the id of the exposure-request that the main page handles when it forwards, absent for a forward that the main
	// page starts itself. A forward with origin lives only while its origin request waits on the host.
	Origin  *uint64         `json:"origin"`
	Surface string          `json:"surface"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// ExposureForward forwards a request to a surface page and returns its reply {result} or {error}. The request has no time limit:
// the reply of the surface document, the end of that document, the reload of the page or the end of its origin request ends it.
// When the surface does not exist or the origin request does not wait, it returns a reply that carries an error.
func (h *Host) ExposureForward(ctx context.Context, reqJSON json.RawMessage) (ExposureResult, error) {
	req, err := argument[ExposureForwardRequest]("request", reqJSON)
	if err != nil {
		return ExposureResult{}, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return ExposureResult{}, err
	}
	var origin uint64
	if req.Origin != nil {
		// The relay numbers its requests from 1, so the origin 0 names no request.
		if *req.Origin == 0 {
			return ExposureResult{Error: originEnded(0)}, nil
		}
		origin = *req.Origin
	}
	reply := s.requestSurfaceOf(origin, req.Surface, func(id uint64) error {
		var sent bool
		mainThreadStep(func() {
			if s.views[req.Surface] != nil {
				EmitHost(LevelDebug, "host.trace.exposure.request", map[string]any{"id": id, "surface": req.Surface, "method": req.Method})
				s.window.Emit("exposure-request", map[string]any{
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

// requestSurface sends a request to the document of a surface and waits for its reply. A request of a page that the host asked
// to reload is refused, because that page no longer answers the calls that the document needs to reply. The check runs after the
// relay holds the request, so askPageToReload ends the request when it runs before the check.
func (s *Surfaces) requestSurface(surface string, send func(id uint64) error) ExposureResult {
	return s.requestSurfaceOf(0, surface, send)
}

// requestSurfaceOf is requestSurface for a forward that serves the request origin, 0 for none.
func (s *Surfaces) requestSurfaceOf(origin uint64, surface string, send func(id uint64) error) ExposureResult {
	return s.host.relay.RequestOf(origin, relayTarget{owner: s, surface: surface}, func(id uint64) error {
		if s.pageReloading.Load() {
			return fmt.Errorf("the page of the window is reloading")
		}
		return send(id)
	})
}

// askPageToReload sends the reload request to a ready page, which ends the page (endPage). A request to the page or to its surface
// documents would keep the page from reloading: the page waits for the replies of its calls, and a call that waits for an answer
// of the page gets none, because the page sends no call after the reload request (docs/spec/native-host.md#page-reload). The
// requests end after the event, so a page that receives the failure already sends no report of it.
func (s *Surfaces) askPageToReload(emit func()) {
	emit()
	s.host.endPage(s)
}

// pageStarted records that a new main page started, which accepts requests to surface documents again.
func (s *Surfaces) pageStarted() {
	s.pageReloading.Store(false)
	s.pageProcessStarted()
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
	mainThreadStep(func() {
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

// exposureRegister forwards the registration of a surface page to the main page. The page of a view has no surface
// bridge of its own, so the main page relays its registration with the identity of the window (docs/spec/exposure.md#relay).
func (s *Surfaces) exposureRegister(viewID uint64, req SurfaceRegistration) error {
	caller := s.surfaceOf(viewID)
	s.mu.Lock()
	_, hasView := s.views[req.Surface]
	s.mu.Unlock()
	isMainPage := caller == "" && viewID == uint64(s.window.ID())
	if err := CheckRegistrationCaller(caller, req.Surface, isMainPage, hasView); err != nil {
		return err
	}
	return s.recordRegistration(req)
}

// CheckRegistrationCaller verifies a registration caller: either the page view of the requested surface itself, or the
// main page of the window registering for a surface with a view (docs/spec/exposure.md#relay).
func CheckRegistrationCaller(callerSurface, requested string, callerIsMainPage bool, hasView bool) error {
	if callerSurface != "" {
		if callerSurface != requested {
			return fmt.Errorf("this document is not surface %q", requested)
		}
		return nil
	}
	if callerIsMainPage && hasView {
		return nil
	}
	return fmt.Errorf("this document is not surface %q", requested)
}

// ExposureRegister records the registration that the main page of the window relayed from the page of a view. It is the
// entrance of the page call exposureRegister (docs/spec/exposure.md#relay).
func (h *Host) ExposureRegister(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[SurfaceRegistration]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.exposureRegister(uint64(s.window.ID()), req)
}

// recordRegistration validates the entry, records it with the window and announces it to the main page.
func (s *Surfaces) recordRegistration(req SurfaceRegistration) error {
	if req.Kind != "status" && req.Kind != "command" && req.Kind != "element" {
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
	s.windowEvent("exposure-registered", req)
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
		s.window.Emit("exposure-registered", req)
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
		if _, err := s.host.ask(context.Background(), s, "command.run", flush); err != nil {
			return err
		}
	}
	// The reload has no time limit: the ready report of the new page ends it, and so do a start of the new page that fails, the
	// close of the window and the end of its page process, after which no ready report comes (docs/spec/native-host.md#page-reload).
	// A page process that ended before the reload does not end it, because the reload starts a new page.
	ends, ended := s.waitEnd()
	if ended == windowClosedEnd {
		return rpcError(codeNoWindow, "%s", ReloadEndText(ended, runningCalls.Of(s.window.Name(), time.Now())))
	}
	ready := make(chan error, 1)
	s.host.mu.Lock()
	s.readied = append(s.readied, ready)
	s.host.mu.Unlock()
	if pageReady {
		// A ready page reads again by itself after all calls it sent received a reply. When the host reads again, the reply that was being
		// written at that moment is lost (docs/spec/native-host.md#page-reload).
		s.askPageToReload(func() { s.window.Emit("page-reload") })
	} else {
		mainThreadStep(func() { s.window.StartWorkbench() })
	}
	select {
	case err := <-ready:
		return err
	case <-ends:
		// The reload ended, so a later ready of the window answers no ended reload.
		s.host.mu.Lock()
		s.readied = slices.DeleteFunc(s.readied, func(waiting chan error) bool { return waiting == ready })
		s.host.mu.Unlock()
		return rpcError(codeNoWindow, "%s", ReloadEndText(s.lastWaitEnd(), runningCalls.Of(s.window.Name(), time.Now())))
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
		s.windowEvent("exposure-registered", map[string]any{"surface": id, "closed": true})
		// The surface closed or its document was replaced, so the producer of its watches ended (docs/spec/exposure.md#methods).
		if s.host.endpoint != nil {
			s.host.endpoint.ProducerEnded(s.name, id, "surface-closed")
		}
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

// PageRequest sends the request of the endpoint connection ctx to the main page of window. It has no time limit: the reply,
// the end of the page or the end of ctx ends it.
func (b hostBackend) PageRequest(ctx context.Context, window, method string, params json.RawMessage) (json.RawMessage, error) {
	s, err := b.window(window)
	if err != nil {
		return nil, err
	}
	return b.h.ask(ctx, s, method, params)
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

func (b hostBackend) HostCommand(window, name string, params json.RawMessage, reply *ReplyScope) (any, error) {
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
			s.window.Maximize()
		} else {
			s.window.Unmaximize()
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
		s.window.SetSize(*p.Width, *p.Height)
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
		return nil, s.useWindow(func(window platform.Window) error { return system.MoveWindow(window, *p.X, *p.Y) })
	case "host.window.raise":
		return nil, s.useWindow(system.RaiseWindow)
	case "host.window.lower":
		return nil, s.useWindow(system.LowerWindow)
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
		// A quit that the menu item requests follows the response of this request.
		return nil, WithResponseOwner(reply, func() error {
			return s.useWindow(func(window platform.Window) error { return system.MenuSelect(window, *p.Menu, *p.Title) })
		})
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
		// A quit that the Dock item requests follows the response of this request.
		return nil, WithResponseOwner(reply, func() error {
			var selected error
			mainThreadStep(func() { selected = system.DockSelect(*p.Title) })
			return selected
		})
	case "host.window.reload":
		return nil, s.reloadPage()
	case "host.window.presented":
		displayed, err := windowPresented(reply.Context(), b.h, s)
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
		// The quit follows the response of this request, so the client receives null before the endpoint closes.
		b.h.quit.Request(func() {
			reply.AfterResponse(func(ReplyOutcome) {
				QuitWithCause("quit-command", HostQuitSource("quit-command"), func() { routine.Go("quit", framework.Quit) })
			})
		})
	default:
		return nil, rpcError(codeUnknownName, "unknown command %s", name)
	}
	return nil, nil
}

var pointerPhaseCodes = map[string]int{"move": 0, "down": 1, "drag": 2, "up": 3, "scroll": 4}

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
	var pressed uintptr
	err = s.useWindow(func(window platform.Window) error {
		return readPressThenDeliver(func() error {
			if input.Phase != "down" {
				return nil
			}
			var err error
			pressed, err = viewAt(window, input.X, input.Y)
			return err
		}, func() error {
			return system.InjectPointer(window, input.Pointer, input.X, input.Y, pointerPhaseCodes[input.Phase], button,
				input.DeltaX, input.DeltaY, input.Clicks, func(result platform.PointerResult, held platform.ButtonHeld) {
					done <- delivery{result, held}
				})
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
		return rpcError(codeTimeout, "the document did not receive the input")
	case platform.PointerButtonHeld:
		return rpcError(codeButtonHeld, "%s", ButtonHeldMessage(got.held))
	case platform.PointerPressOpen:
		return rpcError(codePressOpen, "pointer %s holds an open press of this button; send up before the next down", input.Pointer)
	case platform.PointerHeld:
		return rpcError(codePointerHeld, "%s", PointerHeldMessage(got.held))
	}
	if pressed != 0 {
		s.press(pressed)
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

// PointerHeldMessage builds the message of the 1011 error: the pointer whose open press rejected the input and the state that the
// press holds (docs/spec/exposure.md#named-pointers).
func PointerHeldMessage(held platform.ButtonHeld) string {
	return fmt.Sprintf("pointer %s holds a press that this input would share: %s", held.Pointer, held.Reason)
}

// activate makes the window the key window of an application that answers as active without activating the application
// (docs/spec/exposure.md#methods), and waits until the web view of the window receives the active state.
// When activation does not finish, it returns a 1006 error that names the stage where it stopped.
func (s *Surfaces) activate(x, y float64) error {
	done := make(chan error, 1)
	err := s.useWindow(func(window platform.Window) error {
		return system.ActivateWindow(window, x, y, func(result error) { done <- result })
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
	err = s.useWindow(func(window platform.Window) error {
		var injected error
		result, injected = system.InjectKey(window, input.Key, input.Text, input.Modifiers, input.Down)
		return injected
	})
	if err != nil {
		return nativeError(codeNoInput, err)
	}
	if result == platform.PointerInactive {
		return rpcError(codeInactive, "keys of an active application reach only its key window")
	}
	return delivered(result == platform.PointerDelivered, nil)
}

func (b hostBackend) Text(window string, input TextInput) error {
	s, err := b.window(window)
	if err != nil {
		return err
	}
	var result platform.PointerResult
	err = s.useWindow(func(window platform.Window) error {
		var injected error
		result, injected = system.InjectText(window, input.Phase, input.Text, input.SelectionStart, input.SelectionLength,
			input.ReplacementStart, input.ReplacementLength)
		return injected
	})
	if err != nil {
		return nativeError(codeNoInput, err)
	}
	if result != platform.PointerDelivered {
		return rpcError(codeInvalidParams, "the window has no text input client that takes the text")
	}
	return nil
}

// native reads the native JSON with read on the UI thread and puts it into into. inspect runs after the read in the same UI thread
// task.
func native(read func() (string, error), into any, inspect func()) error {
	var text string
	var err error
	mainThreadStep(func() {
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
func (s *Surfaces) nativeFacts(read func(window platform.Window) (string, error), into any, inspect func()) error {
	var text string
	err := s.useWindow(func(window platform.Window) error {
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

// validateActivationObservation refuses missing evidence rather than inventing
// a zero counter. Keep the native object intact in the public status.
func validateActivationObservation(raw json.RawMessage) error {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return fmt.Errorf("window facts missing or invalid activationObservation")
	}
	registered := strings.TrimSpace(string(value["registered"]))
	if registered != "true" && registered != "false" {
		return fmt.Errorf("window facts activationObservation.registered must be a boolean")
	}
	var count string
	if err := json.Unmarshal(value["count"], &count); err != nil {
		return fmt.Errorf("window facts activationObservation.count must be a canonical unsigned decimal string")
	}
	number, err := strconv.ParseUint(count, 10, 64)
	if err != nil || strconv.FormatUint(number, 10) != count {
		return fmt.Errorf("window facts activationObservation.count must be a canonical uint64 decimal string")
	}
	return nil
}

// windowFacts is the result of sp_window_facts of native/darwin.
type windowFacts struct {
	ActivationObservation json.RawMessage `json:"activationObservation"`
	Responder             struct {
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
	Scale       float64      `json:"scale"`
	RefreshRate *int         `json:"refreshRate"`
	Zoomed      bool         `json:"zoomed"`
	Key         bool         `json:"key"`
	VirtualKey  bool         `json:"virtualKey"`
	Cursor      *string      `json:"cursor"`
	Active      bool         `json:"active"`
	Occluded    bool         `json:"occluded"`
	Display     *int         `json:"display"`
	Order       *WindowOrder `json:"order"`
	Children    int          `json:"children"`
	PageProcess int          `json:"pageProcess"`
	// PagelessProcesses is null on a platform whose facts do not report the WebContent processes without a page.
	PagelessProcesses []PagelessProcess    `json:"pagelessProcesses"`
	Controls          []WindowControl      `json:"controls"`
	Webviews          []windowWebviewFacts `json:"webviews"`
	NativeSurfaces    []struct {
		frame
		View   uint64 `json:"view"`
		Hidden bool   `json:"hidden"`
	} `json:"nativeSurfaces"`
	AppDomWebviews   int `json:"appDomWebviews"`
	DocumentWebviews int `json:"documentWebviews"`
}

type windowWebviewFacts struct {
	frame
	View     uint64  `json:"view"`
	Hidden   bool    `json:"hidden"`
	Focused  bool    `json:"focused"`
	Main     bool    `json:"main"`
	Document bool    `json:"document"`
	Draws    bool    `json:"draws"`
	Alpha    float64 `json:"alpha"`
	Process  int     `json:"process"`
	Blurred  bool    `json:"blurred"`
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
	// Process is the WebContent process of the document web view, 0 before it has one.
	Process int `json:"process"`
	// Blurred is true while the host blurs the document web view natively, as it does while a dialog is open.
	Blurred bool `json:"blurred"`
}

// windowDocument is the host.window entry of the document web view of key at order.
func windowDocument(key DocumentKey, order int, view windowWebviewFacts) WindowDocument {
	return WindowDocument{Surface: key.Surface, Document: key.Name,
		Frame: view.frame, Visible: !view.Hidden, Focused: view.Focused, Order: order, Process: view.Process, Blurred: view.Blurred}
}

// PagelessProcess is a WebContent process that held a page of the application and holds none, while it lives. Ending is true when
// WebKit ends it because its process pool keeps no process cache, false when the cache may keep it.
type PagelessProcess struct {
	Pid    int  `json:"pid"`
	Ending bool `json:"ending"`
}

// UnmarshalJSON reads a row of the native facts and refuses a row without a positive pid or without ending.
func (p *PagelessProcess) UnmarshalJSON(text []byte) error {
	var row struct {
		Pid    *int  `json:"pid"`
		Ending *bool `json:"ending"`
	}
	if err := json.Unmarshal(text, &row); err != nil {
		return fmt.Errorf("window facts have an invalid pageless process %s: %w", text, err)
	}
	if row.Pid == nil || *row.Pid <= 0 || row.Ending == nil {
		return fmt.Errorf("window facts have an invalid pageless process %s", text)
	}
	p.Pid, p.Ending = *row.Pid, *row.Ending
	return nil
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
	Surface string `json:"surface"`
	Name    string `json:"name"`
	Frame   frame  `json:"frame"`
	Visible bool   `json:"visible"`
	Drawing bool   `json:"drawing"`
	Focused bool   `json:"focused"`
	// Blurred is true while the host blurs the image region natively, as it does while a dialog is open.
	Blurred   bool `json:"blurred"`
	Presented *struct {
		Width      int     `json:"width"`
		Height     int     `json:"height"`
		Scale      float64 `json:"scale"`
		Generation uint64  `json:"generation"`
		Raster     uint64  `json:"raster"`
		Sequence   int     `json:"sequence"`
	} `json:"presented"`
	// PresentedFrames is the number of frames of the region that the host marked presented since the region was attached.
	PresentedFrames uint64 `json:"presentedFrames"`
	Layer           struct {
		Bounds        frame   `json:"bounds"`
		ContentsScale float64 `json:"contentsScale"`
	} `json:"layer"`
	Error *string `json:"error"`
}

// windowRegion returns the host.window entry of the image region key from the native facts text of the region and the
// state that the host holds for it.
func windowRegion(key ImageKey, text string, images *Images) (WindowRegion, error) {
	region := WindowRegion{Surface: key.Surface, Name: key.Name}
	if err := json.Unmarshal([]byte(text), &region); err != nil {
		return WindowRegion{}, fmt.Errorf("image %s/%s facts: %w", key.Surface, key.Name, err)
	}
	// presented is the size of the presented image with the identity of the frame that the host marked presented; null while no frame of the current raster is presented.
	if presented, ok := images.PresentedFrame(key); ok && region.Presented != nil {
		region.Presented.Generation = presented.Generation
		region.Presented.Raster = presented.Raster
		region.Presented.Sequence = presented.Sequence
	} else {
		region.Presented = nil
	}
	// drawing is the drawing state that the host last sent the supplier (docs/spec/native-surfaces.md#image-regions).
	region.Drawing = images.SentDrawing(key)
	presentedFrames, err := images.PresentedFrames(key)
	if err != nil {
		return WindowRegion{}, fmt.Errorf("image %s/%s: %w", key.Surface, key.Name, err)
	}
	region.PresentedFrames = presentedFrames
	return region, nil
}

// WindowResponder is the first responder of the window. Owner is what holds it, one of workbench, surface, document, modal,
// webview, and native. webview is a web view that is not registered, and native is a view outside the web views (for example an
// image region). The workbench is the main web view, or the content view of a window without a main page. Surface is the surface
// that contains the first responder.
type WindowResponder struct {
	Class    string  `json:"class"`
	Owner    string  `json:"owner"`
	Surface  *string `json:"surface"`
	Document *string `json:"document"`
}

// windowResponder is the first responder of host.window: the class of the responder view, the web view that holds it (0 for
// a view outside the web views), the surface host that contains it (0 for none) and whether it is the main web view, read
// against the surface hosts, the documents and the modal web view of the window.
func windowResponder(class string, view, surface uint64, main bool, named map[uint64]string, documents map[uint64]DocumentKey, modalHandle uint64) WindowResponder {
	out := WindowResponder{Class: class, Owner: "native"}
	if id, ok := named[surface]; ok && surface != 0 {
		out.Surface = &id
	}
	if view != 0 {
		key, document := documents[view]
		switch {
		case document && key.Name == viewRegionName:
			// The view of a view surface is the document "" of its surface, and its responder is the owner surface
			// (docs/spec/exposure.md#keyboard-focus).
			out.Owner, out.Surface = "surface", &key.Surface
		case document:
			out.Owner, out.Surface, out.Document = "document", &key.Surface, &key.Name
		case out.Surface != nil:
			out.Owner = "surface"
		case modalHandle != 0 && modalHandle == view:
			out.Owner = "modal"
		case main:
			out.Owner = "workbench"
		default:
			out.Owner = "webview"
		}
	} else if surface == 0 && !framework.MainPage() {
		// A window without a main page draws the workbench in its content view, outside every web view and surface host.
		out.Owner = "workbench"
	}
	return out
}

// WindowFrameCounters are the frame counters of host.window. The mygo host counts them through the frame reports of its
// workbench (U7). On the other hosts WebKit draws the workbench, and the host counts neither its frames nor the command buffers
// that WebKit commits for it, so frames, commandBuffers and settled are null.
type WindowFrameCounters struct {
	Frames         *uint64 `json:"frames"`
	CommandBuffers *uint64 `json:"commandBuffers"`
	Settled        *bool   `json:"settled"`
}

// WindowOrder is the place of a window among the windows on the screen: the number of windows of its window level in front of
// it, the number of windows of that level, and whether a window of another process stands in front of it over a part of it.
type WindowOrder struct {
	Index        int  `json:"index"`
	Count        int  `json:"count"`
	OtherInFront bool `json:"otherInFront"`
}

// WindowStatus is the value of host.window.
type WindowStatus struct {
	ActivationObservation json.RawMessage `json:"activationObservation"`
	WindowFrameCounters
	Responder         WindowResponder   `json:"responder"`
	Frame             frame             `json:"frame"`
	Pointer           point             `json:"pointer"`
	Content           frame             `json:"content"`
	Scale             float64           `json:"scale"`
	RefreshRate       *int              `json:"refreshRate"`
	Maximized         bool              `json:"maximized"`
	Key               bool              `json:"key"`
	VirtualKey        bool              `json:"virtualKey"`
	Cursor            *string           `json:"cursor"`
	Active            bool              `json:"active"`
	Occluded          bool              `json:"occluded"`
	Display           *int              `json:"display"`
	Order             *WindowOrder      `json:"order"`
	Children          int               `json:"children"`
	PageProcess       *int              `json:"pageProcess"`
	PagelessProcesses []PagelessProcess `json:"pagelessProcesses"`
	Quitting          bool              `json:"quitting"`
	AppDomWebviews    int               `json:"appDomWebviews"`
	DocumentWebviews  int               `json:"documentWebviews"`
	Controls          []WindowControl   `json:"controls"`
	Webviews          []WindowWebview   `json:"webviews"`
	Surfaces          []WindowSurface   `json:"surfaces"`
	Documents         []WindowDocument  `json:"documents"`
	Regions           []WindowRegion    `json:"regions"`
	Modal             *WindowModal      `json:"modal"`
}

// viewNames reads, on the UI thread, the ids of the surface web views and the addresses of the modal web views.
func (s *Surfaces) viewNames() (named map[uint64]string) {
	named = map[uint64]string{}
	for view, id := range s.named {
		named[uint64(view)] = id
	}
	return named
}

// performanceProcesses reads the WebContent processes of the page and of the document web views of the window for the sampler of
// the performance trace. It reads the window state, which runs on the UI thread.
func (s *Surfaces) performanceProcesses() (PerformanceWindowProcesses, error) {
	state, err := s.windowState()
	if err != nil {
		return PerformanceWindowProcesses{}, err
	}
	processes := PerformanceWindowProcesses{
		Page: state.PageProcess, Documents: make([]PerformanceDocumentProcess, 0, len(state.Documents)),
	}
	for _, document := range state.Documents {
		processes.Documents = append(processes.Documents, PerformanceDocumentProcess{Surface: document.Surface, Document: document.Document, Process: document.Process})
	}
	return processes, nil
}

// registeredSurface returns the surface id that the registry names for a native surface view. A view without a
// registered surface fails with an error that names the view address, which is the view of the window facts that
// locates the view.
func registeredSurface(named map[uint64]string, view uint64) (string, error) {
	id, ok := named[view]
	if !ok {
		return "", fmt.Errorf("unregistered native surface %d", view)
	}
	return id, nil
}

// windowWebviewCounts returns the web view counts of host.window from the native window facts.
func windowWebviewCounts(facts windowFacts) (appDom, document int) {
	return facts.AppDomWebviews, facts.DocumentWebviews
}

// windowWebviewRow returns the host.window row of the web view at drawing order order from its native facts.
func windowWebviewRow(order int, view windowWebviewFacts) WindowWebview {
	return WindowWebview{Frame: view.frame, Main: view.Main, Document: view.Document,
		Visible: !view.Hidden, Focused: view.Focused, Order: order}
}

// modalOrder returns the order of an open modal in host.window from the number of native surfaces and the number of
// web views. The orders of native surfaces and of web views are indexes of two lists, and the modal is attached above
// both, so its order is above every index of either list.
func modalOrder(nativeSurfaces, webviews int) int {
	return nativeSurfaces + webviews
}

// windowState reads the current value of host.window.
func (s *Surfaces) windowState() (WindowStatus, error) {
	var facts windowFacts
	var named map[uint64]string
	var documents map[uint64]DocumentKey
	regions := []WindowRegion{}
	err := s.nativeFacts(func(window platform.Window) (string, error) {
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
			region, err := windowRegion(key, text, s.images)
			if err != nil {
				return "", err
			}
			regions = append(regions, region)
		}
		return system.WindowFacts(window)
	}, &facts, nil)
	if err != nil {
		return WindowStatus{}, err
	}
	if err := validateActivationObservation(facts.ActivationObservation); err != nil {
		return WindowStatus{}, err
	}
	// The native facts were read in the same UI-thread operation.
	out := WindowStatus{
		ActivationObservation: facts.ActivationObservation,
		Frame:                 facts.Frame, Pointer: facts.Pointer, Content: frame{Width: facts.Content.Width, Height: facts.Content.Height},
		Scale: facts.Scale, RefreshRate: facts.RefreshRate, Maximized: facts.Zoomed, Key: facts.Key, VirtualKey: facts.VirtualKey, Cursor: facts.Cursor, Active: facts.Active, Occluded: facts.Occluded, Display: facts.Display, Order: facts.Order, Children: facts.Children,
		Quitting: s.host.quit.Active(),
		Controls: facts.Controls, Surfaces: []WindowSurface{}, Documents: []WindowDocument{}, Regions: regions,
		Webviews: []WindowWebview{}, PagelessProcesses: facts.PagelessProcesses,
	}
	if framework.MainPage() {
		out.PageProcess = &facts.PageProcess
	}
	if s.window != nil {
		if frames := s.window.Frames(); frames != nil {
			out.WindowFrameCounters = frames.Counters()
		}
	}
	out.AppDomWebviews, out.DocumentWebviews = windowWebviewCounts(facts)
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
				order := modalOrder(len(facts.NativeSurfaces), len(facts.Webviews))
				modal.Order = &order
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
		id, err := registeredSurface(named, view.View)
		if err != nil {
			return WindowStatus{}, err
		}
		out.Surfaces = append(out.Surfaces, WindowSurface{ID: id, Frame: view.frame, Visible: !view.Hidden, Order: order})
	}
	for order, view := range facts.Webviews {
		out.Webviews = append(out.Webviews, windowWebviewRow(order, view))
		if key, ok := documents[view.View]; ok {
			out.Documents = append(out.Documents, windowDocument(key, order, view))
		}
	}
	out.Responder = windowResponder(facts.Responder.Class, facts.Responder.Webview, facts.Responder.Surface, facts.Responder.Main, named, documents, modalHandle)
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
	err := s.nativeFacts(func(window platform.Window) (string, error) { return system.WindowHit(window, x, y) }, &got, func() {
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
		return map[string]any{"kind": "workbench"}, nil
	default:
		return map[string]any{"kind": "native", "identifier": got.Identifier, "view": got.Hit}, nil
	}
}

// fullscreen switches the window to full screen or back and returns once with the native result: the end of the transition, a
// refusal with 1006, the close of the window with 1003 and the failure of a started transition with 1005, each with the native
// message. It has no time limit, because the native change answers every request by one of these events. macOS ignores a request
// during a transition, so the native code continues the handling after that transition ends.
func (s *Surfaces) fullscreen(on bool) error {
	type ended struct {
		result  platform.FullscreenResult
		message string
	}
	done := make(chan ended, 1)
	err := s.useWindow(func(window platform.Window) error {
		return system.Fullscreen(window, on, func(result platform.FullscreenResult, message string) { done <- ended{result, message} })
	})
	if err != nil {
		return err
	}
	got := <-done
	switch got.result {
	case platform.FullscreenDone:
		return nil
	case platform.FullscreenRefused:
		return rpcError(codeInactive, "%s", got.message)
	case platform.FullscreenClosed:
		return rpcError(codeNoWindow, "%s", got.message)
	default:
		return rpcError(codeTimeout, "%s", got.message)
	}
}

// placementLast is the method of the workbench of a window that answers once the last placement that the workbench made or holds
// ended, with the failure of that placement (docs/spec/host-contract.md, exposure.window-presented.waits-for-the-last-placement).
const placementLast = "workbench.placement.last"

// windowPresented waits until the window presented its current layout and returns the display time of that screen. A placement
// that waits behind a running one is known only to the workbench of the window, so the wait asks the workbench for its last
// placement first; a workbench that has not started holds none. host.window.presented and diagnostics.drag wait with it. The wait
// has no time limit: its events end it, and so do the close of the window, the end of its page process and the end of ctx, the
// endpoint connection of the request.
func windowPresented(ctx context.Context, h *Host, s *Surfaces) (float64, error) {
	ends, ended := s.waitEnd()
	if ended != "" {
		return 0, waitEndError(ended)
	}
	return lastPlacementPresented(func() error {
		h.mu.Lock()
		ready := s.ready
		h.mu.Unlock()
		if !ready {
			return nil
		}
		_, err := h.ask(ctx, s, placementLast, nil)
		return err
	}, func() <-chan struct{} {
		return firstEnd(ctx, ends, s.whenSettled())
	}, func() (float64, error) {
		return s.presented(ctx)
	})
}

// firstEnd returns a channel that closes when settled closes, when the waits of the window end or when ctx ends.
func firstEnd(ctx context.Context, ends <-chan struct{}, settled <-chan struct{}) <-chan struct{} {
	done := make(chan struct{})
	routine.Go("presented-settled", func() {
		select {
		case <-settled:
		case <-ends:
		case <-ctx.Done():
		}
		close(done)
	})
	return done
}

// lastPlacementPresented waits for placed, then for settled, the end of a continuous update, and then for presented. It has no
// time limit: placed ends by the answer of the workbench or the end of its window, and settled and presented by their events.
func lastPlacementPresented(placed func() error, settled func() <-chan struct{}, presented func() (float64, error)) (float64, error) {
	if err := placed(); err != nil {
		return 0, fmt.Errorf("the last placement of the window: %w", err)
	}
	<-settled()
	return presented()
}

// presented waits until the surface layout transaction of the window and the current picture raster are fixed and the main page and the visible app document
// display that layout, and returns the time (ms, mach absolute time) at which that screen is displayed. It has no time limit: the
// close of the window and the end of its page process end it with 1003, and the end of ctx, the endpoint connection of the request,
// ends it with an error.
func (s *Surfaces) presented(ctx context.Context) (float64, error) {
	ends, ended := s.waitEnd()
	if ended != "" {
		return 0, waitEndError(ended)
	}
	if ctx.Err() != nil {
		return 0, connectionEnded()
	}
	waitFrame := func() (float64, error) {
		done := make(chan struct {
			displayed float64
			err       error
		}, 1)
		var err error
		mainThreadStep(func() {
			var present unsafe.Pointer
			if present, err = s.window.SettledPresentation(); err != nil {
				return
			}
			err = system.AfterSettled(s.window.NativeWindow(), present, func(displayed float64, callbackErr error) {
				done <- struct {
					displayed float64
					err       error
				}{displayed: displayed, err: callbackErr}
			})
		})
		if err != nil {
			return 0, err
		}
		select {
		case result := <-done:
			if result.err != nil {
				return 0, result.err
			}
			return result.displayed, nil
		case <-ends:
			return 0, waitEndError(s.lastWaitEnd())
		case <-ctx.Done():
			return 0, connectionEnded()
		}
	}

	// An open modal is on the screen at the time this reports only after its revealed web view presented its first frame, so
	// the wait ends at the paint of the modal, at a change of the modal state or at an end of the window (modals.go). It runs before
	// the settled wait, so the display time that the settled wait reports is at or after the paint of the modal.
	if err := s.waitForModalPaint(ctx); err != nil {
		return 0, err
	}
	if _, err := waitFrame(); err != nil {
		return 0, err
	}
	for {
		// Instrument of the display barrier wait (V5-104).
		barrierStarted := time.Now()
		barrier := make(chan error, 1)
		// The end of the request closes stop, so the raster wait ends with the request that waited for it.
		stop := make(chan struct{})
		routine.Go("presented-raster", func() { barrier <- s.images.WaitCurrentError(stop) })
		var barrierErr error
		select {
		case barrierErr = <-barrier:
		case <-ends:
			close(stop)
			return 0, waitEndError(s.lastWaitEnd())
		case <-ctx.Done():
			close(stop)
			return 0, connectionEnded()
		}
		PerformanceObserve("host", func() map[string]any {
			return map[string]any{
				"event": "barrier", "wait_us": time.Since(barrierStarted).Microseconds(),
				"ok": barrierErr == nil,
			}
		})
		if barrierErr != nil {
			return 0, rpcError(codeHandler, "the current image raster failed to present: %v", barrierErr)
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
func (b hostBackend) sidecarsState() SidecarStatus {
	if b.h.sidecars != nil {
		return b.h.sidecars.Status()
	}
	return SidecarStatus{Closing: []ClosingSurface{}, Outdated: []OutdatedSidecar{}}
}

// sidecarsChanged enqueues an immutable status without acquiring the window registry.
func (h *Host) sidecarsChanged(value SidecarStatus) {
	if h.endpoint != nil {
		h.endpoint.NotifyWatchers("host.sidecars", value)
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

// latestRead runs one reading at a time. A request that arrives during a reading joins one further reading, so a reading
// begins after the last request and no older value is sent after a newer one. A change can arrive on every frame of a
// region and each reading waits for the main thread, so a goroutine for each change would pile up while that thread is busy.
type latestRead struct {
	mu      sync.Mutex
	running bool
	again   bool
}

func (r *latestRead) ask(name string, read func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.running {
		r.again = true
		return
	}
	r.running = true
	routine.Go(name, func() {
		for {
			read()
			r.mu.Lock()
			if !r.again {
				r.running = false
				r.mu.Unlock()
				return
			}
			r.again = false
			r.mu.Unlock()
		}
	})
}

// windowChanged sends the new value to the connections that watch host.window. When no connection watches, it does not
// read the value. It is also called on the UI thread, so the value is read in another goroutine.
func (s *Surfaces) windowChanged() {
	if s.host == nil || s.host.endpoint == nil {
		return
	}
	if !s.host.endpoint.Watching(s.name, "host.window") {
		EmitHost(LevelDebug, "host.trace.status.notify", map[string]any{"status": "host.window", "window": s.name, "decision": "unwatched"})
		return
	}
	s.windowReads.ask("window-status", func() {
		state, err := s.windowState()
		if WindowClosed(err) {
			// A window that closed before the status was read has no status to announce.
			return
		}
		if err != nil {
			s.fail("host.window", err)
			return
		}
		// The endpoint keeps no record of the values it sent, so every value read while the window is watched is sent.
		EmitHost(LevelDebug, "host.trace.status.notify", map[string]any{"status": "host.window", "window": s.name, "decision": "sent"})
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
			_, err = s.host.ask(context.Background(), s, method, params)
		case !isHostName(t.name):
			params := map[string]any{}
			for key, value := range t.watchParams() {
				params[key] = value
			}
			_, err = s.host.ask(context.Background(), s, "status.watch", params)
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

// The ends of the waits of a window for its page (Surfaces.waitEnd).
const (
	windowClosedEnd = "the window closed"
	pageEndedEnd    = "the page process ended"
)

// waitEnd returns the channel that the next end of the waits of the window closes, and the end that already holds, empty when
// none does. A wait reads both before it waits, so an end before the wait reaches its event ends it the same way.
func (s *Surfaces) waitEnd() (<-chan struct{}, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.waitEnds == nil {
		s.waitEnds = make(chan struct{})
	}
	return s.waitEnds, s.waitsEnded
}

// lastWaitEnd is the end that last ended the waits of the window.
func (s *Surfaces) lastWaitEnd() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastEnd
}

// waitEndError is the 1003 error of a wait that the end end of the window or of its page ended.
func waitEndError(end string) *RPCError {
	return rpcError(codeNoWindow, "%s", end)
}

// endWaits ends the waits of the window for its page with end and records end for the waits that begin after it.
func (s *Surfaces) endWaits(end string) {
	s.mu.Lock()
	if s.waitsEnded != windowClosedEnd {
		s.waitsEnded = end
	}
	s.lastEnd = end
	if s.waitEnds != nil {
		close(s.waitEnds)
	}
	s.waitEnds = make(chan struct{})
	s.mu.Unlock()
}

// endWindow ends the waits of a window that closed: no page of it reports or presents again.
func (s *Surfaces) endWindow() { s.endWaits(windowClosedEnd) }

// pageProcessEnded ends the waits of a window whose main page process ended: that page reports and presents nothing more, and
// the waits that begin before a new page starts end too.
func (s *Surfaces) pageProcessEnded() { s.endWaits(pageEndedEnd) }

// pageProcessStarted clears the end of the page process when a new main page starts, so the waits of the new page wait for it.
func (s *Surfaces) pageProcessStarted() {
	s.mu.Lock()
	if s.waitsEnded == pageEndedEnd {
		s.waitsEnded = ""
	}
	s.mu.Unlock()
}
