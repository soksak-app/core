// 노출 요청의 전달과 호스트 항목.
//
// 엔드포인트의 요청은 창의 메인 페이지에 exposure-request 이벤트로 전달하고, 페이지는
// ExposureReply 로 답한다. 표면 페이지가 등록한 항목은 메인 페이지가 ExposureForward 로
// 요청하고, 호스트가 그 표면 페이지에 전달한다. host 소유 항목은 호스트가 직접 처리한다.
// 형식은 docs/spec/exposure.md 에 정의한다.

package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// pageTimeout 은 문서의 답을 기다리는 시간이다.
const pageTimeout = 10 * time.Second

// hostEntry 는 호스트가 선언한 항목 하나다.
type hostEntry struct {
	Description string
	// Schema 는 상태 값, Params 와 Result 는 명령의 매개변수와 결과 스키마다.
	Schema, Params, Result map[string]any
}

// rectSchema 는 {x, y, width, height} 의 스키마다.
var rectSchema = map[string]any{"type": "object", "properties": map[string]any{
	"x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"},
	"width": map[string]any{"type": "number"}, "height": map[string]any{"type": "number"},
}}

var emptyObject = map[string]any{"type": "object", "properties": map[string]any{}}
var nullSchema = map[string]any{"type": "null"}

// presentedSchema 는 host.window.presented 의 결과다. displayed 는 표시 시각(ms, mach 절대 시각)이다.
var presentedSchema = map[string]any{"type": "object", "properties": map[string]any{"displayed": map[string]any{"type": "number"}}}

var hostStatus = map[string]hostEntry{
	"host.window": {
		Description: "Window frame and system pointer location in screen coordinates, content size, backing scale, the maximum refresh rate of its screen (null when the window is on no screen), maximized, key and application active state, whether other windows cover the whole window, child window count, the WebContent process of the app page (0 before it starts), window buttons, webview frames, native surfaces, document regions, image regions, and the open native modal.",
		Schema: map[string]any{"type": "object", "properties": map[string]any{
			"frame":       rectSchema,
			"pointer":     map[string]any{"type": "object", "properties": map[string]any{"x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"}}},
			"content":     rectSchema,
			"scale":       map[string]any{"type": "number"},
			"refreshRate": map[string]any{"type": []string{"integer", "null"}},
			"pageProcess": map[string]any{"type": "integer"},
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
					"sequence": map[string]any{"type": "integer"},
					"width":    map[string]any{"type": "integer"}, "height": map[string]any{"type": "integer"},
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

// listedEntries 는 exposure.list 에 넣을 호스트 항목을 이름 순서로 반환한다.
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

// ExposureResult 는 문서가 보낸 답이다. 결과 또는 오류 하나를 담는다. ExposureForward 가 반환한다.
type ExposureResult struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

// Relay 는 문서에 보낸 요청과 그 답을 연결한다. T 는 요청을 받은 문서를 가리키며, 답은 같은 문서에서 와야 한다.
type Relay[T comparable] struct {
	mu      sync.Mutex
	next    uint64
	waiting map[uint64]*relayWaiter[T]
	// expired 는 시간이 초과된 최근 요청이다. 늦은 답의 지연을 오류에 밝히기 위해 relayExpiredLimit 개까지
	// 기억하고 가장 오래된 것을 버린다(docs/spec/exposure.md#errors).
	expired []relayExpired[T]
}

// relayExpiredLimit 는 늦은 답을 위해 기억하는 시간 초과 요청 수다.
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

// NewRelay 는 빈 중계를 만든다.
func NewRelay[T comparable]() *Relay[T] {
	return &Relay[T]{waiting: map[uint64]*relayWaiter[T]{}}
}

// Request 는 target 에 보낼 요청 id 를 만들고 send 로 보낸 뒤 답을 기다린다. send 가 실패하면 기다리지 않고
// 1003 오류를 반환한다. 제한 시간이 지나면 요청을 지우고 1005 오류를 반환한다. timeout 이 0 이면 답이나
// Abandon 까지 기다린다.
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
			r.expired = r.expired[1:]
		}
		r.expired = append(r.expired, relayExpired[T]{id: id, target: target, sent: sent, timeout: timeout})
		r.mu.Unlock()
		return ExposureResult{Error: rpcError(codeTimeout, "the document did not reply within %d ms", timeout.Milliseconds())}
	}
}

// Resolve 는 요청 id 의 답을 전달한다. 요청을 받은 문서가 아닌 곳에서 온 답과 이미 끝난 요청의 답은 오류다.
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

// Abandon 은 match 가 참인 문서에 보낸 요청에 1003 오류로 답한다. 사라진 문서는 답하지 않는다.
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

// relayTarget 은 창의 메인 문서(surface 가 빈 값) 또는 표면 문서다.
type relayTarget struct {
	owner   *Surfaces
	surface string
}

// ask 는 창 s 의 메인 페이지에 요청을 보내고 답을 기다린다. timeout 이 0 이면 답이나 페이지 종료까지
// 기다린다. 준비되지 않은 페이지는 요청을 받지 못하므로 1003 을 반환한다. 요청을 등록한 뒤 준비
// 여부를 보므로, 그 사이 다시 읽힌 페이지의 요청은 여기서 거부되거나 Abandon 으로 끝난다.
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

// ExposureReplyRequest 는 문서가 요청 하나에 보낸 답이다. surface 가 없으면 메인 문서의 답이다.
type ExposureReplyRequest struct {
	ID      uint64          `json:"id"`
	Surface json.RawMessage `json:"surface,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error"`
}

// ReplySurface 는 답을 보낸 표면을 반환한다. surface 필드가 없으면 메인 문서이므로 빈 값이다. null, 빈 문자열,
// 문자열이 아닌 값은 메인 문서의 답으로 바꾸지 않고 오류로 거부한다.
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

// ExposureReply 는 메인 페이지가 exposure-request 에 보낸 답을 받는다.
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
		// 표면을 제거할 때 그 표면의 요청은 surfacesClosed 가 이미 1003 으로 끝냈다. 늦은 답은 답할 요청이 없으므로
		// 버리고 관측으로 남긴다(docs/spec/exposure.md).
		log.Println(RemovedSurfaceReply(req.ID, surface))
		return nil
	}
	return h.relay.Resolve(req.ID, relayTarget{owner: s, surface: surface}, ExposureResult{Result: req.Result, Error: req.Error})
}

// RemovedSurfaceReply 는 제거된 표면이 보낸 늦은 답의 관측 줄이다.
func RemovedSurfaceReply(id uint64, surface string) string {
	return fmt.Sprintf("exposure reply %d of removed surface %q arrived after its request ended", id, surface)
}

// ExposureChange 는 감시 중인 상태의 새 값이다.
type ExposureChange struct {
	Name    string `json:"name"`
	Surface string `json:"surface,omitempty"`
	// Value 는 상태의 새 값이다. 값이 null 이거나 없는 변경은 값이 null 인 변경이다.
	Value json.RawMessage `json:"value,omitempty"`
}

// CheckPageStatusChange 는 페이지가 이름 name 의 상태 변경을 보낼 수 있는지 확인한다. host 상태는 host 만 바꾼다.
func CheckPageStatusChange(name string) error {
	if isHostName(name) {
		return fmt.Errorf("the page cannot change host status %s", name)
	}
	return nil
}

// ExposureChanged 는 메인 페이지가 알린 상태 변경을 그 상태를 감시하는 연결에 전달한다.
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

// ExposureForwardRequest 는 메인 페이지가 표면 페이지에 전달할 요청이다.
type ExposureForwardRequest struct {
	Surface string          `json:"surface"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	// Timeout 은 이 요청의 제한 시간(ms)이다. 없으면 10 초다. 선언의 timeout 을 페이지가 전달한다.
	Timeout json.RawMessage `json:"timeout,omitempty"`
}

// maxForwardTimeout 은 전달 요청이 지정할 수 있는 가장 긴 제한 시간이다.
const maxForwardTimeout = 600000

// ForwardTimeout 은 전달 요청의 제한 시간을 정한다. status.next 는 값이 바뀔 때까지 답하지 않으므로
// 제한 시간이 없고(0), timeout 을 받지 않는다. timeout 은 1 이상 600000 이하의 정수 ms 다.
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

// ExposureForward 는 요청을 표면 페이지에 전달하고 그 답 {result} 또는 {error} 를 반환한다.
// 표면이 없거나 답하지 않으면 오류를 담은 답을 반환한다.
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
	// status.next 는 제한 시간이 없다. 표면이 닫히면 1003 으로 끝난다.
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

// SurfaceRegistration 은 표면 페이지가 등록한 항목이다.
type SurfaceRegistration struct {
	Surface string `json:"surface"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
}

// surfaceOf 는 네이티브 웹뷰 viewID 가 표시하는 표면의 id 를 반환한다. 표면이 아니면 빈 값이다.
func (s *Surfaces) surfaceOf(viewID uint64) string {
	var id string
	application.InvokeSync(func() {
		if view := nativeViews[viewID]; view != nil && view.owner == s {
			id = s.named[uintptr(view.handle)]
		}
	})
	return id
}

// AuthorizeSurfaceCaller 는 surface 요청을 명시된 호출자 identity 와 대조해 검증한다. 소유한 surface
// view 또는 명시된 메인 페이지 identity 하나만 허용하며, 알 수 없는 view 를 메인 페이지로 취급하지 않는다.
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

// exposureRegister 는 표면 페이지의 등록을 메인 페이지에 전달한다.
func (s *Surfaces) exposureRegister(viewID uint64, req SurfaceRegistration) error {
	if surface := s.surfaceOf(viewID); surface == "" || surface != req.Surface {
		return fmt.Errorf("this document is not surface %q", req.Surface)
	}
	if req.Kind != "status" && req.Kind != "command" && req.Kind != "dom" {
		return fmt.Errorf("unknown exposure kind %q", req.Kind)
	}
	// 표면이 등록하는 코어 이름은 core.surface.* 뿐이다(docs/spec/exposure.md).
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

// replayRegistrations 는 표면 페이지의 등록을 다시 읽힌 메인 페이지에 다시 알린다. 표면은 메인
// 페이지가 다시 읽혀도 남으므로, 새 페이지는 이전 페이지가 받은 등록을 이 호출로 받는다.
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

// reloadPage 는 메인 페이지를 같은 WebContent 프로세스에서 다시 읽게 하고, 새 페이지가 준비를 알릴 때까지 기다린다.
// 준비된 페이지는 먼저 대기 중인 저장을 끝낸다(docs/spec/projects.md#persistence). WebKit 은 새 페이지가 보이는
// 내용을 처음 그릴 때까지 이전 페이지를 화면에 두고, 이전 페이지의 정리는 새 페이지의 시작 문서 요청이 한다
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
		// 준비된 페이지는 보낸 호출이 모두 답을 받은 뒤 스스로 다시 읽는다. 호스트가 다시 읽으면 그 순간 쓰고 있던
		// 응답이 사라진다(docs/spec/native-host.md#page-reload).
		s.window.EmitEvent("page-reload")
	} else {
		application.InvokeSync(func() { s.window.Reload() })
	}
	select {
	case <-ready:
		return nil
	case <-time.After(pageTimeout):
		return rpcError(codeTimeout, "the reloaded page did not report ready within %s", pageTimeout)
	}
}

// exposureReply 는 표면 페이지가 전달받은 요청에 보낸 답을 받는다.
// surfacesClosed 는 제거된 표면의 등록 해제를 메인 페이지에 알리고 그 표면에 보낸 요청을 끝낸다.
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

// byName 은 이름이 name 인 창을 반환한다.
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

// hostBackend 는 엔드포인트에 창과 페이지를 제공한다. Host 의 공개 메서드는 페이지에 바인딩되므로
// 이 메서드들은 별도 형식에 둔다.
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
	// 메인 페이지는 표면에 전달한 명령을 선언의 제한 시간 안에 끝내므로 command.run 에는 제한을 두지 않는다.
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
		go application.Get().Quit()
	default:
		return nil, rpcError(codeUnknownName, "unknown command %s", name)
	}
	return nil, nil
}

var pointerPhaseCodes = map[string]int{"move": 0, "down": 1, "drag": 2, "up": 3, "scroll": 4}

// receiveTimeout 은 input.pointer 의 누름과 뗌이 문서의 수신을 기다리는 시간이다.
const receiveTimeout = 2 * time.Second

// activateTimeout 은 input.pointer 의 activate 가 활성화를 기다리는 시간이다.
const activateTimeout = 5 * time.Second

// errInactive 는 창이 키 창이 아니어서 이동을 전달하지 못했을 때의 오류다.
func errInactive() *RPCError { return rpcError(codeInactive, "the window is not active") }

// delivered 는 네이티브 키 입력의 결과를 엔드포인트 오류로 바꾼다.
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

// ButtonHeldMessage 는 1007 오류의 메시지를 만든다. 거부한 차례의 mask 와 최전면 애플리케이션을
// 적는다(docs/spec/exposure.md).
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

// activate 는 애플리케이션을 활성화하고 창을 키 창으로 만든 뒤, 창의 웹뷰가 활성 상태를 받을
// 때까지 기다린다. 활성화가 끝나지 않으면 멈춘 단계를 적은 1006 오류를 반환한다.
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

// native 는 UI 스레드에서 read 로 네이티브 JSON 을 읽어 into 에 넣는다. inspect 는 같은 UI 스레드
// 작업에서 읽은 뒤 실행한다.
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

// nativeFacts 는 UI 스레드의 한 단계에서 이 창의 네이티브 창으로 read 가 읽은 네이티브 JSON 을 into 에 넣는다.
// inspect 는 같은 단계에서 읽은 뒤 실행한다. 그 단계 전에 닫힌 창은 1003 이다.
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

// frame 은 {x, y, width, height} 이다.
type frame struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// point 는 화면 좌표의 한 점이다.
type point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// windowFacts 는 native/darwin 의 sp_window_facts 결과다.
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

// WindowSurface 는 host.window 의 표면 하나다.
type WindowSurface struct {
	ID      string `json:"id"`
	Frame   frame  `json:"frame"`
	Visible bool   `json:"visible"`
	Order   int    `json:"order"`
}

// WindowDocument 는 host.window 의 문서 영역 하나다.
type WindowDocument struct {
	Surface  string `json:"surface"`
	Document string `json:"document"`
	Frame    frame  `json:"frame"`
	Visible  bool   `json:"visible"`
	Focused  bool   `json:"focused"`
	Order    int    `json:"order"`
}

// WindowWebview 는 창 좌표계에서 웹뷰 하나의 프레임이다.
type WindowWebview struct {
	Frame    frame `json:"frame"`
	Main     bool  `json:"main"`
	Document bool  `json:"document"`
	Visible  bool  `json:"visible"`
	Focused  bool  `json:"focused"`
	Order    int   `json:"order"`
}

// ModalBackground 는 모달 웹뷰의 배경 그리기 상태다.
type ModalBackground struct {
	Draws bool    `json:"draws"`
	Alpha float64 `json:"alpha"`
}

// WindowModal 은 host.window 의 열린 모달이다. 뷰가 아직 없으면 Frame, Order, Background 가 null 이다.
type WindowModal struct {
	ID         string           `json:"id"`
	Mode       string           `json:"mode"`
	Shown      bool             `json:"shown"`
	Frame      *frame           `json:"frame"`
	Order      *int             `json:"order"`
	Background *ModalBackground `json:"background"`
}

// WindowControl 은 창 단추 하나의 영역이다.
type WindowControl struct {
	frame
	Hidden bool `json:"hidden"`
}

// WindowRegion 는 host.window 의 이미지 영역 하나다.
type WindowRegion struct {
	Surface   string `json:"surface"`
	Name      string `json:"name"`
	Frame     frame  `json:"frame"`
	Visible   bool   `json:"visible"`
	Focused   bool   `json:"focused"`
	Presented *struct {
		Width  int     `json:"width"`
		Height int     `json:"height"`
		Scale  float64 `json:"scale"`
	} `json:"presented"`
	Layer struct {
		Bounds        frame   `json:"bounds"`
		ContentsScale float64 `json:"contentsScale"`
	} `json:"layer"`
	Error *string `json:"error"`
}

// WindowResponder 는 창의 첫 응답자다. Owner 는 그것을 담은 웹뷰의 종류이며 page, surface,
// document, modal, webview, native 중 하나다. webview 는 등록되지 않은 웹뷰이고, native 는
// 웹뷰 밖의 뷰(예: 이미지 영역)다. Surface 는 첫 응답자를 담은 표면이다.
type WindowResponder struct {
	Class    string  `json:"class"`
	Owner    string  `json:"owner"`
	Surface  *string `json:"surface"`
	Document *string `json:"document"`
}

// WindowStatus 는 host.window 의 값이다.
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
	AppDomWebviews   int              `json:"appDomWebviews"`
	DocumentWebviews int              `json:"documentWebviews"`
	Controls         []WindowControl  `json:"controls"`
	Webviews         []WindowWebview  `json:"webviews"`
	Surfaces         []WindowSurface  `json:"surfaces"`
	Documents        []WindowDocument `json:"documents"`
	Regions          []WindowRegion   `json:"regions"`
	Modal            *WindowModal     `json:"modal"`
}

// viewNames 는 UI 스레드에서 표면 웹뷰의 id 와 모달 웹뷰의 주소를 읽는다.
func (s *Surfaces) viewNames() (named map[uint64]string) {
	named = map[uint64]string{}
	for view, id := range s.named {
		named[uint64(view)] = id
	}
	return named
}

// windowState 는 host.window 의 현재 값을 읽는다.
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
		PageProcess: facts.PageProcess,
		Controls:    facts.Controls, Surfaces: []WindowSurface{}, Documents: []WindowDocument{}, Regions: regions,
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

// screens 는 host.screens 의 현재 값을 읽는다.
func screens() (any, error) {
	var out []map[string]any
	if err := native(system.Screens, &out, nil); err != nil {
		return nil, err
	}
	return out, nil
}

// menuItems 는 host.menu 의 현재 값을 읽는다. language 는 호스트가 관리하는 메뉴 언어이고
// menus 는 구성된 메뉴다. 언어는 호스트 자신의 상태이지 메뉴 제목에서 추측하는 값이 아니다.
func menuItems() (any, error) {
	var menus []any
	if err := native(system.MenuItems, &menus, nil); err != nil {
		return nil, err
	}
	return map[string]any{"language": currentMenuLanguage(), "menus": menus}, nil
}

// dockItems 는 host.dock 의 현재 값을 읽는다.
func dockItems() (any, error) {
	var out []string
	if err := native(system.DockItems, &out, nil); err != nil {
		return nil, err
	}
	return out, nil
}

// hit 은 창 좌표 (x, y) 의 소유자를 반환한다.
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

// fullscreen 은 창을 전체 화면으로 바꾸거나 되돌리고 전환이 끝난 뒤 반환한다. macOS 는 전환 중의
// 요청을 무시하므로 네이티브 코드가 그 전환이 끝난 뒤에 이어서 처리한다.
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

// presented 는 창의 표면 배치 트랜잭션과 현재 그림 래스터가 확정되고 메인 페이지와 보이는 앱 문서가
// 그 배치를 표시할 때까지 기다리고, 그 화면이 표시되는 시각(ms, mach 절대 시각)을 반환한다.
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
		// 표시 장벽 대기의 계기(V5-104): 이 대기가 타임아웃에 걸리면 화면이 멈춘다.
		barrierStarted := time.Now()
		barrierErr := s.images.WaitCurrentError(remaining)
		PerformanceObserve(s.host.configDir, "host", func() map[string]any {
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

// windowsChanged 는 host.windows 를 감시하는 연결에 창 목록을 보낸다. 값은 windows.list 의 결과이고,
// 창이 열리거나 닫히거나 제목, 프로젝트, 키 상태가 바뀔 때 호출한다.
// sidecarsState 는 host.sidecars 의 현재 값이다.
func (b hostBackend) sidecarsState() map[string]any {
	closing := []ClosingSurface{}
	outdated := []OutdatedSidecar{}
	if b.h.sidecars != nil {
		closing = b.h.sidecars.Closing()
		outdated = b.h.sidecars.Outdated()
	}
	return map[string]any{"closing": closing, "outdated": outdated}
}

// sidecarsChanged 는 host.sidecars 를 감시하는 연결에 새 값을 보낸다.
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

// windowChanged 는 host.window 를 감시하는 연결에 새 값을 보낸다. 감시하는 연결이 없으면
// 값을 읽지 않는다. UI 스레드에서도 호출하므로 값은 다른 고루틴에서 읽는다.
func (s *Surfaces) windowChanged() {
	if s.host == nil || s.host.endpoint == nil || !s.host.endpoint.Watching(s.name, "host.window") {
		return
	}
	go func() {
		state, err := s.windowState()
		var coded *RPCError
		if errors.As(err, &coded) && coded.Code == codeNoWindow {
			// 상태를 읽기 전에 닫힌 창은 알릴 상태가 없다.
			return
		}
		if err != nil {
			s.log(fmt.Sprintf("host.window: %v", err))
			return
		}
		s.host.endpoint.StatusChanged(s.name, "host.window", "", state)
	}()
}

// rewatch 는 다시 로드된 메인 페이지에 이 창의 감시와 진단 구독을 다시 요청한다.
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
			s.log(fmt.Sprintf("rewatch %s: %v", t.name, err))
		}
	}
}

// log 는 이 창의 진단 기록을 켠 연결에 줄 하나를 보낸다. 진단 빌드가 아니면 보낼 곳이 없다.
func (s *Surfaces) log(line string) {
	if transcribe != nil && s.host != nil && s.host.endpoint != nil {
		transcribe(s.host.endpoint, s.name, line)
	}
}
