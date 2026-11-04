// A request of the endpoint for a name of a view: the registration of the view, the forward through the host and the answer of the
// view, on a shell of the native workbench (docs/spec/exposure.md#relay, docs/spec/native-surfaces.md#view-surfaces).
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// viewRelay is the host side of a window: exposureRegister announces the registration, exposureForward emits the request with its
// surface and returns the reply that the surface sends, and the requests of the page wait for it.
type viewRelay struct {
	stored *surfaceHost
	f      *shellFixture
	t      *testing.T
	mu     sync.Mutex
	// next numbers the forwards, open holds the forwards that wait, and answers the replies of the main page by request id.
	next     uint64
	open     map[uint64]chan map[string]any
	answers  map[float64]map[string]any
	requests []map[string]any
	pushed   []map[string]any
	changed  []string
	// post is the reply of viewRequest.
	post func(request map[string]any) (any, error)
}

func newViewRelay(t *testing.T) *viewRelay {
	t.Helper()
	r := &viewRelay{t: t, stored: &surfaceHost{}, open: map[uint64]chan map[string]any{}, answers: map[float64]map[string]any{},
		post: func(map[string]any) (any, error) { return nil, nil }}
	read := func(argument json.RawMessage) map[string]any {
		var value map[string]any
		if err := json.Unmarshal(argument, &value); err != nil {
			t.Error(err)
		}
		return value
	}
	r.stored.calls = map[string]workbench.HostCall{
		"exposureRegister": func(_ context.Context, argument json.RawMessage) (any, error) {
			r.emit("exposure-registered", read(argument))
			return nil, nil
		},
		"exposureForward": func(_ context.Context, argument json.RawMessage) (any, error) {
			request := read(argument)
			r.mu.Lock()
			r.next++
			id := r.next
			reply := make(chan map[string]any, 1)
			r.open[id] = reply
			r.mu.Unlock()
			r.emit("exposure-request", map[string]any{"id": id, "surface": request["surface"], "method": request["method"], "params": request["params"]})
			return <-reply, nil
		},
		"exposureReply": func(_ context.Context, argument json.RawMessage) (any, error) {
			reply := read(argument)
			r.mu.Lock()
			defer r.mu.Unlock()
			if reply["surface"] == nil {
				r.answers[reply["id"].(float64)] = reply
				return nil, nil
			}
			open := r.open[uint64(reply["id"].(float64))]
			if open == nil {
				return nil, errors.New("the reply has no request")
			}
			delete(r.open, uint64(reply["id"].(float64)))
			open <- reply
			return nil, nil
		},
		"exposureChanged": func(_ context.Context, argument json.RawMessage) (any, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.changed = append(r.changed, string(argument))
			return nil, nil
		},
		"viewRequest": func(_ context.Context, argument json.RawMessage) (any, error) {
			request := read(argument)
			r.mu.Lock()
			r.requests = append(r.requests, request)
			post := r.post
			r.mu.Unlock()
			return post(request)
		},
		"viewEvent": func(_ context.Context, argument json.RawMessage) (any, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.pushed = append(r.pushed, read(argument))
			return nil, nil
		},
	}
	r.f = surfaceShellOn(t, installedDocument, r.stored)
	return r
}

func (r *viewRelay) emit(name string, data map[string]any) {
	r.f.pending.post(func() { r.f.shell.Event(name, []any{data}) })
}

// surface returns a surface of the terminal plugin.
func (r *viewRelay) surface() string {
	r.t.Helper()
	for id, surface := range r.stored.lastSurfaces(r.t) {
		if surface["plugin"] == "terminal" {
			return id
		}
	}
	r.t.Fatal("no surface of the terminal plugin")
	return ""
}

// call makes a view call and fails when it is refused.
func (r *viewRelay) call(surface, command string, params any) any {
	r.t.Helper()
	reply := viewCall(r.t, r.f, r.stored, surface, command, params)
	if reply["error"] != nil {
		r.t.Fatalf("view call %s: %v", command, reply["error"])
	}
	return reply["result"]
}

// ask delivers a request of the endpoint.
func (r *viewRelay) ask(id int, method, params string) {
	r.emit("exposure-request", map[string]any{"id": id, "method": method, "params": json.RawMessage(params)})
}

// answer waits for the reply of the main page to request id.
func (r *viewRelay) answer(id int) map[string]any {
	r.t.Helper()
	var reply map[string]any
	r.f.pending.until(r.t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		reply = r.answers[float64(id)]
		return reply != nil
	})
	return reply
}

// request waits for command request number n of the views.
func (r *viewRelay) request(n int) map[string]any {
	r.t.Helper()
	var request map[string]any
	r.f.pending.until(r.t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		if len(r.requests) <= n {
			return false
		}
		request = r.requests[n]
		return true
	})
	return request
}

func TestACommandOfAViewRunsInThatView(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "terminal.input"})
	r.ask(9, "command.run", `{"name": "terminal.input", "params": {"data": "ls\r"}}`)
	request := r.request(0)
	if request["surface"] != surface || request["command"] != "terminal.input" || request["generation"] != float64(1) ||
		!reflect.DeepEqual(request["params"], map[string]any{"data": "ls\r"}) {
		t.Fatalf("the view received %v", request)
	}
	r.emit("view-reply", map[string]any{"surface": surface, "plugin": "terminal", "id": request["id"], "result": map[string]any{"written": 3}})
	if reply := r.answer(9); !reflect.DeepEqual(reply["result"], map[string]any{"written": float64(3)}) {
		t.Fatalf("the reply is %v", reply)
	}
}

func TestTheRegistrationOfACommandFollowsItsDeclaration(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	refused := func(name, text string) {
		t.Helper()
		reply := viewCall(t, r.f, r.stored, surface, "runtime.command.register", map[string]any{"name": name})
		failure, _ := reply["error"].(map[string]any)
		if failure == nil || failure["message"] != text {
			t.Fatalf("the reply is %v", reply)
		}
	}
	refused("terminal.none", "surface "+surface+" registered undeclared command terminal.none")
	r.call(surface, "runtime.command.register", map[string]any{"name": "terminal.input"})
	refused("terminal.input", "command terminal.input is already registered")
	r.ask(9, "command.run", `{"name": "terminal.none", "params": {}}`)
	if failure := r.answer(9)["error"].(map[string]any); failure["code"] != float64(workbench.UnknownName) {
		t.Fatalf("the reply is %v", failure)
	}
	r.ask(10, "command.run", `{"name": "terminal.close", "params": {}}`)
	if failure := r.answer(10)["error"].(map[string]any); failure["code"] != float64(workbench.Unregistered) {
		t.Fatalf("the reply is %v", failure)
	}
}

func TestAFailedCommandOfAViewKeepsItsCode(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "terminal.input"})
	r.ask(9, "command.run", `{"name": "terminal.input", "params": {}}`)
	request := r.request(0)
	r.emit("view-reply", map[string]any{"surface": surface, "plugin": "terminal", "id": request["id"], "error": map[string]any{"code": 1002, "message": "no session"}})
	if failure := r.answer(9)["error"].(map[string]any); failure["code"] != float64(1002) || failure["message"] != "no session" {
		t.Fatalf("the reply is %v", failure)
	}
}

func TestAViewThatDoesNotReplyEndsItsCommandAtTheDeclaredLimit(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "terminal.close"})
	r.ask(9, "command.run", `{"name": "terminal.close", "params": {}}`)
	failure := r.answer(9)["error"].(map[string]any)
	if failure["code"] != float64(workbench.Failed) || failure["message"] != "command terminal.close did not reply within 40ms" {
		t.Fatalf("the reply is %v", failure)
	}
}

func TestAPostOfAReplacedViewSettlesItsCommand(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "terminal.input"})
	r.post = func(map[string]any) (any, error) {
		return map[string]any{"cancelled": true, "sourceGeneration": 1}, nil
	}
	r.ask(9, "command.run", `{"name": "terminal.input", "params": {}}`)
	if reply := r.answer(9); !reflect.DeepEqual(reply["result"], map[string]any{"cancelled": true, "sourceGeneration": float64(1)}) {
		t.Fatalf("the reply is %v", reply)
	}
	r.post = func(map[string]any) (any, error) { return "later", nil }
	r.ask(10, "command.run", `{"name": "terminal.input", "params": {}}`)
	if failure := r.answer(10)["error"].(map[string]any); failure["message"] != "native command post returned an invalid disposition" {
		t.Fatalf("the reply is %v", failure)
	}
	r.post = func(map[string]any) (any, error) { return nil, errors.New("no document") }
	r.ask(11, "command.run", `{"name": "terminal.input", "params": {}}`)
	if failure := r.answer(11)["error"].(map[string]any); failure["message"] != "no document" {
		t.Fatalf("the reply is %v", failure)
	}
}

func TestAStatusOfAViewAnswersThroughItsSubscription(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.native.on", map[string]any{"name": "exposure-request"})
	r.call(surface, "runtime.native.call", map[string]any{"name": "registered", "payload": map[string]any{"kind": "status", "name": "terminal.screen"}})
	r.ask(9, "status.get", `{"name": "terminal.screen"}`)
	var pushed map[string]any
	r.f.pending.until(t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		if len(r.pushed) == 0 {
			return false
		}
		pushed = r.pushed[0]
		return true
	})
	data := pushed["data"].(map[string]any)
	if pushed["event"] != "exposure-request" || pushed["surface"] != surface || data["method"] != "status.get" {
		t.Fatalf("the view received %v", pushed)
	}
	r.call(surface, "runtime.native.call", map[string]any{"name": "exposureReply", "payload": map[string]any{"id": data["id"], "result": "screen"}})
	if reply := r.answer(9); reply["result"] != "screen" {
		t.Fatalf("the reply is %v", reply)
	}
}

func TestAWatchedStatusOfAViewReachesTheHost(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.native.on", map[string]any{"name": "exposure-request"})
	r.call(surface, "runtime.native.call", map[string]any{"name": "registered", "payload": map[string]any{"kind": "status", "name": "terminal.screen"}})
	r.ask(9, "status.watch", `{"name": "terminal.screen"}`)
	var id any
	r.f.pending.until(t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		if len(r.pushed) == 0 {
			return false
		}
		id = r.pushed[0]["data"].(map[string]any)["id"]
		return true
	})
	changed := map[string]any{"name": "changed", "payload": map[string]any{"name": "terminal.screen", "value": "one", "version": 1}}
	r.call(surface, "runtime.native.call", changed)
	r.call(surface, "runtime.native.call", map[string]any{"name": "exposureReply", "payload": map[string]any{"id": id}})
	r.answer(9)
	r.f.pending.until(t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		return len(r.changed) == 1
	})
	if got := r.changed[0]; got != `{"name":"terminal.screen","value":"one"}` {
		t.Fatalf("the host received %s", got)
	}
	reply := viewCall(t, r.f, r.stored, surface, "runtime.native.call", map[string]any{"name": "changed", "payload": map[string]any{"name": "terminal.screen", "value": "one", "version": 0}})
	if failure, _ := reply["error"].(map[string]any); failure == nil || !strings.Contains(failure["message"].(string), "positive integer version") {
		t.Fatalf("the reply is %v", reply)
	}
}

func TestARequestForAViewWithoutASubscriptionIsRefused(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.native.call", map[string]any{"name": "registered", "payload": map[string]any{"kind": "status", "name": "terminal.screen"}})
	r.ask(9, "status.get", `{"name": "terminal.screen"}`)
	if failure := r.answer(9)["error"].(map[string]any); failure["code"] != float64(workbench.Gone) {
		t.Fatalf("the reply is %v", failure)
	}
}

func TestAViewRunsACommandThatItRegistered(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "terminal.input"})
	r.f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "terminal", "generation": 1, "id": 6, "command": "terminal.input", "params": map[string]any{"data": "x"}}})
	request := r.request(0)
	if request["surface"] != surface || request["command"] != "terminal.input" {
		t.Fatalf("the view received %v", request)
	}
	r.emit("view-reply", map[string]any{"surface": surface, "plugin": "terminal", "id": request["id"], "result": "done"})
	r.f.pending.until(t, func() bool {
		for _, reply := range r.stored.replies {
			if reply["id"] == float64(6) {
				return reply["result"] == "done"
			}
		}
		return false
	})
}

func TestAClosedSurfaceLeavesTheChoice(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "terminal.input"})
	r.emit("exposure-registered", map[string]any{"surface": surface, "closed": true})
	r.f.settle()
	r.ask(9, "command.run", `{"name": "terminal.input", "params": {}}`)
	if failure := r.answer(9)["error"].(map[string]any); failure["code"] != float64(workbench.Unregistered) {
		t.Fatalf("the reply is %v", failure)
	}
}

func TestAViewFollowsAStatusOfItsPlugin(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.native.on", map[string]any{"name": "exposure-request"})
	r.call(surface, "runtime.native.call", map[string]any{"name": "registered", "payload": map[string]any{"kind": "status", "name": "terminal.screen"}})
	reply := viewCall(t, r.f, r.stored, surface, "runtime.status.watch", map[string]any{"name": "browser.page"})
	if failure, _ := reply["error"].(map[string]any); failure == nil || failure["message"] != "view call runtime.status.watch browser.page is neither a core status nor a status of terminal" {
		t.Fatalf("the reply is %v", reply)
	}
	reply = viewCall(t, r.f, r.stored, surface, "runtime.status.watch", map[string]any{"name": "terminal.screen", "surface": "tab-none"})
	if failure, _ := reply["error"].(map[string]any); failure == nil || failure["message"] != "view call runtime.status.watch surface tab-none is not a surface of terminal" {
		t.Fatalf("the reply is %v", reply)
	}
	r.call(surface, "runtime.status.watch", map[string]any{"name": "terminal.screen", "surface": surface})
	var id any
	r.f.pending.until(t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		if len(r.pushed) == 0 {
			return false
		}
		id = r.pushed[0]["data"].(map[string]any)["id"]
		return true
	})
	r.call(surface, "runtime.native.call", map[string]any{"name": "exposureReply", "payload": map[string]any{"id": id}})
	r.call(surface, "runtime.native.call", map[string]any{"name": "changed", "payload": map[string]any{"name": "terminal.screen", "value": "one", "version": 1}})
	var status map[string]any
	r.f.pending.until(t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		for _, pushed := range r.pushed {
			if pushed["event"] == "status" {
				status = pushed["data"].(map[string]any)
				return true
			}
		}
		return false
	})
	if !reflect.DeepEqual(status, map[string]any{"name": "terminal.screen", "surface": surface, "value": "one"}) {
		t.Fatalf("the view received %v", status)
	}
	r.call(surface, "runtime.status.unwatch", map[string]any{"name": "terminal.screen", "surface": surface})
	r.f.pending.until(t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		last := r.pushed[len(r.pushed)-1]
		return last["data"].(map[string]any)["method"] == "status.unwatch"
	})
}

func TestARightClickInAViewOpensTheMenuOfItsPlugin(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	if answer := r.call(surface, "surface.menu", map[string]any{"x": 10, "y": 20}); answer != true {
		t.Fatalf("the view call answered %v", answer)
	}
	menu := r.f.menu()
	if menu.Title != "터미널" || !slices.Equal(menu.keys(), []string{"terminal.close"}) {
		t.Fatalf("the menu is %+v", menu)
	}
}
