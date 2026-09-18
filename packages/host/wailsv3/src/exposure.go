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
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
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
		Description: "Window frame in screen coordinates, content size, backing scale, maximized, key and application active state, child window count, window buttons, native surfaces, document regions, and the open native modal.",
		Schema: map[string]any{"type": "object", "properties": map[string]any{
			"frame":     rectSchema,
			"content":   rectSchema,
			"scale":     map[string]any{"type": "number"},
			"maximized": map[string]any{"type": "boolean"},
			"key":       map[string]any{"type": "boolean"},
			"active":    map[string]any{"type": "boolean"},
			"children":  map[string]any{"type": "integer"},
			"controls":  map[string]any{"type": "array", "items": rectSchema},
			"surfaces": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"id": map[string]any{"type": "string"}, "frame": rectSchema,
				"visible": map[string]any{"type": "boolean"}, "order": map[string]any{"type": "integer"},
			}}},
			"documents": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"surface": map[string]any{"type": "string"}, "document": map[string]any{"type": "string"},
				"frame": rectSchema, "visible": map[string]any{"type": "boolean"}, "order": map[string]any{"type": "integer"},
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
	"host.dock.select": {Description: "Performs the Dock menu item with the title.", Result: nullSchema,
		Params: map[string]any{"type": "object", "properties": map[string]any{"title": map[string]any{"type": "string"}}}},
	"host.window.reload":    {Description: "Reloads the main page.", Params: emptyObject, Result: nullSchema},
	"host.window.presented": {Description: "Resolves after the main page and visible application documents have presented their current geometry, with the display time of that frame.", Params: emptyObject, Result: presentedSchema},
	"host.hit": {Description: "Returns the owner of a point in window coordinates.",
		Params: map[string]any{"type": "object", "properties": map[string]any{
			"x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"}}},
		Result: map[string]any{"type": "object", "properties": map[string]any{
			"kind":       map[string]any{"type": "string", "enum": []string{"page", "surface", "document", "native"}},
			"surface":    map[string]any{"type": "string"},
			"document":   map[string]any{"type": "string"},
			"identifier": map[string]any{"type": "string"}}}},
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

// waiter 는 답을 기다리는 요청 하나다. surface 가 비어 있으면 메인 페이지의 요청이다.
type waiter struct {
	owner   *Surfaces
	surface string
	reply   chan ExposureResult
}

// relay 는 문서에 보낸 요청과 그 답을 연결한다.
type relay struct {
	mu      sync.Mutex
	next    uint64
	waiting map[uint64]*waiter
}

func (r *relay) open(owner *Surfaces, surface string) (uint64, *waiter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	w := &waiter{owner: owner, surface: surface, reply: make(chan ExposureResult, 1)}
	r.waiting[r.next] = w
	return r.next, w
}

// resolve 는 요청 id 의 답을 전달한다. 요청을 받은 문서가 아닌 곳에서 온 답은 버린다.
func (r *relay) resolve(id uint64, owner *Surfaces, surface string, reply ExposureResult) error {
	r.mu.Lock()
	w := r.waiting[id]
	if w == nil || w.owner != owner || w.surface != surface {
		r.mu.Unlock()
		return fmt.Errorf("exposure reply %d has no matching request", id)
	}
	delete(r.waiting, id)
	r.mu.Unlock()
	w.reply <- reply
	return nil
}

// abandon 은 사라진 문서에 보낸 요청에 1003 오류로 답한다. surfaces 가 nil 이면 창의 모든 요청이다.
func (r *relay) abandon(owner *Surfaces, surfaces map[string]bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, w := range r.waiting {
		if w.owner != owner || (surfaces != nil && !surfaces[w.surface]) {
			continue
		}
		delete(r.waiting, id)
		w.reply <- ExposureResult{Error: rpcError(codeNoWindow, "the document closed before it replied")}
	}
}

// wait 는 답을 기다린다. 제한 시간이 지나면 요청을 지우고 1005 오류를 반환한다. timeout 이 0 이면
// 답이나 abandon 까지 기다린다.
func (r *relay) wait(id uint64, w *waiter, timeout time.Duration) ExposureResult {
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
		r.mu.Unlock()
		select {
		case reply := <-w.reply:
			return reply
		default:
		}
		return ExposureResult{Error: rpcError(codeTimeout, "the document did not reply within %s", timeout)}
	}
}

// forget 은 보내지 않은 요청을 지운다.
func (r *relay) forget(id uint64) {
	r.mu.Lock()
	delete(r.waiting, id)
	r.mu.Unlock()
}

// ask 는 창 s 의 메인 페이지에 요청을 보내고 답을 기다린다. timeout 이 0 이면 답이나 페이지 종료까지
// 기다린다. 준비되지 않은 페이지는 요청을 받지 못하므로 1003 을 반환한다. 요청을 등록한 뒤 준비
// 여부를 보므로, 그 사이 다시 읽힌 페이지의 요청은 여기서 거부되거나 abandon 으로 끝난다.
func (h *Host) ask(s *Surfaces, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	id, w := h.relay.open(s, "")
	h.mu.Lock()
	ready := s.ready
	h.mu.Unlock()
	if !ready {
		h.relay.forget(id)
		return nil, rpcError(codeNoWindow, "the main page is not ready")
	}
	s.window.EmitEvent("exposure-request", map[string]any{"id": id, "method": method, "params": params})
	reply := h.relay.wait(id, w, timeout)
	if reply.Error != nil {
		return nil, reply.Error
	}
	if len(reply.Result) == 0 {
		return json.RawMessage(`null`), nil
	}
	return reply.Result, nil
}

// ExposureReplyRequest 는 문서가 요청 하나에 보낸 답이다.
type ExposureReplyRequest struct {
	ID     uint64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *RPCError       `json:"error"`
}

// ExposureReply 는 메인 페이지가 exposure-request 에 보낸 답을 받는다.
func (h *Host) ExposureReply(ctx context.Context, req ExposureReplyRequest) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return h.relay.resolve(req.ID, s, "", ExposureResult{Result: req.Result, Error: req.Error})
}

// ExposureChange 는 감시 중인 상태의 새 값이다.
type ExposureChange struct {
	Name    string          `json:"name"`
	Surface string          `json:"surface"`
	Value   json.RawMessage `json:"value"`
}

// ExposureChanged 는 메인 페이지가 알린 상태 변경을 그 상태를 감시하는 연결에 전달한다.
func (h *Host) ExposureChanged(ctx context.Context, change ExposureChange) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	if isHostName(change.Name) {
		return fmt.Errorf("the page cannot change host status %s", change.Name)
	}
	h.endpoint.StatusChanged(s.name, change.Name, change.Surface, change.Value)
	return nil
}

// ExposureForwardRequest 는 메인 페이지가 표면 페이지에 전달할 요청이다.
type ExposureForwardRequest struct {
	ID      json.RawMessage `json:"id"`
	Surface string          `json:"surface"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
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
func (h *Host) ExposureForward(ctx context.Context, req ExposureForwardRequest) (ExposureResult, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return ExposureResult{}, err
	}
	timeout, invalid := ForwardTimeout(req.Method, req.Timeout)
	if invalid != nil {
		return ExposureResult{Error: invalid}, nil
	}
	id, w := h.relay.open(s, req.Surface)
	payload, err := json.Marshal(map[string]any{"event": "exposure-request",
		"data": map[string]any{"id": id, "method": req.Method, "params": req.Params}})
	if err != nil {
		return ExposureResult{}, err
	}
	var sent bool
	application.InvokeSync(func() {
		if view := s.views[req.Surface]; view != nil {
			view.execJS("window.__soksakNative?.receive(" + string(payload) + ")")
			sent = true
		}
	})
	if !sent {
		h.relay.abandon(s, map[string]bool{req.Surface: true})
	}
	// status.next 는 제한 시간이 없다. 표면이 닫히면 1003 으로 끝난다.
	reply := h.relay.wait(id, w, timeout)
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

// reloadPage 는 메인 페이지를 다시 읽고, 새 페이지가 준비를 알릴 때까지 기다린다.
func (s *Surfaces) reloadPage() error {
	ready := make(chan struct{})
	s.host.mu.Lock()
	s.readied = append(s.readied, ready)
	s.host.mu.Unlock()
	s.window.Reload()
	select {
	case <-ready:
		return nil
	case <-time.After(pageTimeout):
		return rpcError(codeTimeout, "the reloaded page did not report ready within %s", pageTimeout)
	}
}

// exposureReply 는 표면 페이지가 전달받은 요청에 보낸 답을 받는다.
func (s *Surfaces) exposureReply(viewID uint64, req ExposureReplyRequest) error {
	surface := s.surfaceOf(viewID)
	if surface == "" {
		return errors.New("only surface documents reply to forwarded requests")
	}
	return s.host.relay.resolve(req.ID, s, surface, ExposureResult{Result: req.Result, Error: req.Error})
}

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
	s.host.relay.abandon(s, closed)
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
	case "host.windows":
		return b.Windows(), nil
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
		var moved error
		application.InvokeSync(func() { moved = system.MoveWindow(s.window.NativeWindow(), *p.X, *p.Y) })
		return nil, moved
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
		if err := s.activate(); err != nil {
			return err
		}
	}
	button := 0
	if input.Button == "right" {
		button = 1
	}
	done := make(chan platform.PointerResult, 1)
	application.InvokeSync(func() {
		err = system.InjectPointer(s.window.NativeWindow(), input.X, input.Y, pointerPhaseCodes[input.Phase], button,
			input.DeltaX, input.DeltaY, receiveTimeout.Seconds(), func(result platform.PointerResult) { done <- result })
	})
	if err != nil {
		return rpcError(codeNoInput, "%v", err)
	}
	switch <-done {
	case platform.PointerInactive:
		return errInactive()
	case platform.PointerRejected:
		return rpcError(codeInvalidParams, "the window did not accept the input: the point is outside the content")
	case platform.PointerUnreceived:
		return rpcError(codeTimeout, "the document did not receive the input within %s", receiveTimeout)
	}
	return nil
}

// activate 는 애플리케이션을 활성화하고 창을 키 창으로 만든 뒤, 창의 웹뷰가 활성 상태를 받을
// 때까지 기다린다. 활성화가 끝나지 않으면 멈춘 단계를 적은 1006 오류를 반환한다.
func (s *Surfaces) activate() error {
	done := make(chan error, 1)
	var err error
	application.InvokeSync(func() {
		err = system.ActivateWindow(s.window.NativeWindow(), activateTimeout.Seconds(), func(result error) { done <- result })
	})
	if err != nil {
		return rpcError(codeNoInput, "%v", err)
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
	var ok bool
	application.InvokeSync(func() {
		ok, err = system.InjectKey(s.window.NativeWindow(), input.Key, input.Text, input.Modifiers, input.Down)
	})
	return delivered(ok, err)
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

// frame 은 {x, y, width, height} 이다.
type frame struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// windowFacts 는 native/darwin 의 sp_window_facts 결과다.
type windowFacts struct {
	Frame   frame `json:"frame"`
	Content struct {
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	} `json:"content"`
	Scale    float64         `json:"scale"`
	Zoomed   bool            `json:"zoomed"`
	Key      bool            `json:"key"`
	Active   bool            `json:"active"`
	Children int             `json:"children"`
	Controls []WindowControl `json:"controls"`
	Webviews []struct {
		frame
		View   uint64  `json:"view"`
		Hidden bool    `json:"hidden"`
		Draws  bool    `json:"draws"`
		Alpha  float64 `json:"alpha"`
	} `json:"webviews"`
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
	Order    int    `json:"order"`
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

// WindowStatus 는 host.window 의 값이다.
type WindowStatus struct {
	Frame     frame            `json:"frame"`
	Content   frame            `json:"content"`
	Scale     float64          `json:"scale"`
	Maximized bool             `json:"maximized"`
	Key       bool             `json:"key"`
	Active    bool             `json:"active"`
	Children  int              `json:"children"`
	Controls  []WindowControl  `json:"controls"`
	Surfaces  []WindowSurface  `json:"surfaces"`
	Documents []WindowDocument `json:"documents"`
	Modal     *WindowModal     `json:"modal"`
}

// viewNames 는 UI 스레드에서 표면 웹뷰의 id 와 모달 웹뷰의 주소를 읽는다.
func (s *Surfaces) viewNames() (named map[uint64]string, modalHandle uint64) {
	named = map[uint64]string{}
	for view, id := range s.named {
		named[uint64(view)] = id
	}
	s.mu.Lock()
	if s.modalView != nil {
		modalHandle = uint64(uintptr(s.modalView.handle))
	}
	s.mu.Unlock()
	return named, modalHandle
}

// windowState 는 host.window 의 현재 값을 읽는다.
func (s *Surfaces) windowState() (WindowStatus, error) {
	var facts windowFacts
	var named map[uint64]string
	var documents map[uint64]DocumentKey
	var modalHandle uint64
	err := native(func() (string, error) { return system.WindowFacts(s.window.NativeWindow()) }, &facts,
		func() { named, modalHandle = s.viewNames(); documents = s.documents.Names() })
	if err != nil {
		return WindowStatus{}, err
	}
	out := WindowStatus{
		Frame: facts.Frame, Content: frame{Width: facts.Content.Width, Height: facts.Content.Height},
		Scale: facts.Scale, Maximized: facts.Zoomed, Key: facts.Key, Active: facts.Active, Children: facts.Children,
		Controls: facts.Controls, Surfaces: []WindowSurface{}, Documents: []WindowDocument{},
	}
	if out.Controls == nil {
		out.Controls = []WindowControl{}
	}
	var modal *WindowModal
	s.mu.Lock()
	if s.modal != nil {
		modal = &WindowModal{ID: s.modal.id, Mode: s.modal.content.Mode, Shown: s.modal.visible}
	}
	s.mu.Unlock()
	for order, view := range facts.Webviews {
		if id, ok := named[view.View]; ok {
			out.Surfaces = append(out.Surfaces, WindowSurface{ID: id, Frame: view.frame, Visible: !view.Hidden, Order: order})
		} else if key, ok := documents[view.View]; ok {
			out.Documents = append(out.Documents, WindowDocument{Surface: key.Surface, Document: key.Name,
				Frame: view.frame, Visible: !view.Hidden, Order: order})
		} else if modal != nil && modalHandle != 0 && view.View == modalHandle {
			at, index := view.frame, order
			modal.Frame, modal.Order = &at, &index
			modal.Background = &ModalBackground{Draws: view.Draws, Alpha: view.Alpha}
		}
	}
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
	}
	var named map[uint64]string
	var documents map[uint64]DocumentKey
	var modalHandle uint64
	var modalID string
	err := native(func() (string, error) { return system.WindowHit(s.window.NativeWindow(), x, y) }, &got, func() {
		named, modalHandle = s.viewNames()
		documents = s.documents.Names()
		s.mu.Lock()
		if s.modal != nil {
			modalID = s.modal.id
		}
		s.mu.Unlock()
	})
	if err != nil {
		return nil, err
	}
	switch {
	case got.View != 0 && documents[got.View].Surface != "":
		key := documents[got.View]
		return map[string]any{"kind": "document", "surface": key.Surface, "document": key.Name}, nil
	case got.View != 0 && named[got.View] != "":
		return map[string]any{"kind": "surface", "surface": named[got.View]}, nil
	case got.View != 0 && got.View == modalHandle && modalID != "":
		return map[string]any{"kind": "native", "identifier": "modal:" + modalID}, nil
	case got.Main:
		return map[string]any{"kind": "page"}, nil
	default:
		return map[string]any{"kind": "native", "identifier": got.Identifier}, nil
	}
}

// fullscreen 은 창을 전체 화면으로 바꾸거나 되돌리고 전환이 끝난 뒤 반환한다. macOS 는 전환 중의
// 요청을 무시하므로 네이티브 코드가 그 전환이 끝난 뒤에 이어서 처리한다.
func (s *Surfaces) fullscreen(on bool) error {
	done := make(chan struct{}, 1)
	var err error
	application.InvokeSync(func() {
		err = system.Fullscreen(s.window.NativeWindow(), on, func() { done <- struct{}{} })
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

// presented 는 창의 표면 배치 트랜잭션이 확정되고 메인 페이지와 보이는 앱 문서가 현재 배치를 표시할
// 때까지 기다리고, 그 화면이 표시되는 시각(ms, mach 절대 시각)을 반환한다.
func (s *Surfaces) presented() (float64, error) {
	done := make(chan float64, 1)
	var err error
	application.InvokeSync(func() {
		err = system.AfterSettled(s.window.NativeWindow(), func(displayed float64) { done <- displayed })
	})
	if err != nil {
		return 0, err
	}
	select {
	case displayed := <-done:
		return displayed, nil
	case <-time.After(pageTimeout):
		return 0, rpcError(codeTimeout, "the window did not present within %s", pageTimeout)
	}
}

// windowsChanged 는 host.windows 를 감시하는 연결에 창 목록을 보낸다. 값은 windows.list 의 결과이고,
// 창이 열리거나 닫히거나 제목, 프로젝트, 키 상태가 바뀔 때 호출한다.
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
