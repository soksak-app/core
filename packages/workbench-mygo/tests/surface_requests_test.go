// The requests for the names that surfaces register: the declarations of the plugins, the surfaces that registered each name, the
// choice of a surface, the forwards to it and the values of its watched statuses, as docs/spec/exposure.md gives them to the main page.
package workbench_test

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// terminalExposes are the declarations of a plugin with a status, two commands and an element.
func terminalExposes() workbench.Exposes {
	return workbench.Exposes{
		Status:   []json.RawMessage{json.RawMessage(`{"name": "terminal.screen"}`)},
		Commands: []json.RawMessage{json.RawMessage(`{"name": "terminal.input"}`), json.RawMessage(`{"name": "terminal.close", "timeout": 2500}`)},
		Dom:      []json.RawMessage{json.RawMessage(`{"name": "terminal.view"}`)},
	}
}

// surfaceRequests is a window whose host answers each forward with reply, and which holds the tabs of plugins.
type surfaceRequests struct {
	*relay
	registry  *workbench.Registry
	forwards  []map[string]any
	reply     func(request map[string]any) (any, error)
	plugins   map[string]string
	preferred []string
	frames    map[string][2]float64
	unloaded  map[string]bool
}

func newSurfaceRequests(t *testing.T) *surfaceRequests {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	f := &surfaceRequests{registry: workbench.NewRegistry(declared), plugins: map[string]string{"tab-a": "terminal", "tab-b": "terminal", "tab-c": "browser",
		"space/left/files": "terminal"}, frames: map[string][2]float64{}, unloaded: map[string]bool{}}
	f.relay = newRelay(t, f.registry)
	f.reply = func(map[string]any) (any, error) { return map[string]any{"result": "done"}, nil }
	if err := f.registry.Declare("terminal", terminalExposes()); err != nil {
		t.Fatal(err)
	}
	f.registry.Link(workbench.SurfaceLinks{
		Plugin:    func(surface string) string { return f.plugins[surface] },
		Preferred: func() []string { return f.preferred },
		Unloaded:  func(surface string) bool { return f.unloaded[surface] },
		Frame: func(surface string) (float64, float64, bool) {
			frame, ok := f.frames[surface]
			return frame[0], frame[1], ok
		},
		Forward: func(request map[string]any, answer func(value any, err error)) {
			encoded, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			var read map[string]any
			if err := json.Unmarshal(encoded, &read); err != nil {
				t.Fatal(err)
			}
			f.forwards = append(f.forwards, read)
			answer(f.reply(read))
		},
		Changed: func(name string, surface *string, value any) {
			change := map[string]any{"name": name, "value": value}
			if surface != nil {
				change["surface"] = *surface
			}
			encoded, err := json.Marshal(change)
			if err != nil {
				t.Fatal(err)
			}
			f.changes <- string(encoded)
		},
	})
	return f
}

func (f *surfaceRequests) register(surface, kind, name string) {
	f.t.Helper()
	if err := f.registry.Registered(workbench.SurfaceRegistered{Surface: surface, Kind: kind, Name: name}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *surfaceRequests) refuses(params string, code int, message string) {
	f.t.Helper()
	got, text := f.refused(f.ask("command.run", params))
	if got != code || text != message {
		f.t.Fatalf("the refusal is %d %q, want %d %q", got, text, code, message)
	}
}

func TestAPluginDeclaresItsOwnNamesOnce(t *testing.T) {
	f := newSurfaceRequests(t)
	foreign := workbench.Exposes{Commands: []json.RawMessage{json.RawMessage(`{"name": "browser.go"}`)}}
	if err := f.registry.Declare("terminal", foreign); err == nil || err.Error() != "command browser.go does not belong to terminal" {
		t.Fatalf("the foreign name gave %v", err)
	}
	if err := f.registry.Declare("terminal", terminalExposes()); err == nil || err.Error() != "status terminal.screen is declared twice" {
		t.Fatalf("the second declaration gave %v", err)
	}
	if err := f.registry.Declare("terminal", workbench.Exposes{Status: []json.RawMessage{json.RawMessage(`{}`)}}); err == nil {
		t.Fatal("an entry without a name was declared")
	}
}

func TestTheListHoldsThePluginNamesWithTheirRegistration(t *testing.T) {
	f := newSurfaceRequests(t)
	registered := func(key, name string) bool {
		t.Helper()
		list, _ := f.ask("exposure.list", `{}`)["result"].(map[string]any)
		for _, entry := range list[key].([]any) {
			row := entry.(map[string]any)
			if row["name"] == name {
				return row["registered"].(bool)
			}
		}
		t.Fatalf("the list has no %s %s", key, name)
		return false
	}
	if registered("commands", "terminal.input") || registered("status", "terminal.screen") || registered("dom", "terminal.view") {
		t.Fatal("a name that no surface registered is registered")
	}
	f.register("tab-a", "command", "terminal.input")
	f.register("tab-a", "status", "terminal.screen")
	f.register("tab-a", "dom", "terminal.view")
	if !registered("commands", "terminal.input") || !registered("status", "terminal.screen") || !registered("dom", "terminal.view") {
		t.Fatal("a registered name is not registered")
	}
	f.register("tab-a", "status", "core.surface.input")
	if !registered("status", "core.surface.input") {
		t.Fatal("a core name of a surface is not registered")
	}
}

func TestARegistrationThatTheDeclarationRefusesIsAnError(t *testing.T) {
	f := newSurfaceRequests(t)
	cases := []struct {
		event workbench.SurfaceRegistered
		text  string
	}{
		{workbench.SurfaceRegistered{Surface: "tab-a", Kind: "command", Name: "terminal.none"}, "surface tab-a registered undeclared command terminal.none"},
		{workbench.SurfaceRegistered{Surface: "tab-a", Kind: "command", Name: "core.card.split"}, "surface tab-a registered undeclared command core.card.split"},
		{workbench.SurfaceRegistered{Surface: "tab-c", Kind: "command", Name: "terminal.input"}, "surface tab-c of plugin browser cannot register terminal.input"},
	}
	for _, each := range cases {
		if err := f.registry.Registered(each.event); err == nil || err.Error() != each.text {
			t.Fatalf("%v gave %v", each.event, err)
		}
	}
	// The registration of a surface that the window closed meanwhile names no surface, and its end follows.
	if err := f.registry.Registered(workbench.SurfaceRegistered{Surface: "tab-gone", Kind: "command", Name: "terminal.input"}); err != nil {
		t.Fatal(err)
	}
	f.refuses(`{"name": "terminal.input", "params": {}}`, workbench.Unregistered, "command terminal.input is not registered")
}

func TestARequestChoosesTheSurfaceOfItsName(t *testing.T) {
	f := newSurfaceRequests(t)
	input := `{"name": "terminal.input", "params": {"data": "x"}}`
	f.refuses(`{"name": "terminal.none", "params": {}}`, workbench.UnknownName, "unknown command terminal.none")
	f.refuses(input, workbench.Unregistered, "command terminal.input is not registered")
	f.register("space/left/files", "command", "terminal.input")
	f.refuses(input, workbench.Unregistered, "command terminal.input is not registered")
	f.register("tab-a", "command", "terminal.input")
	f.register("tab-b", "command", "terminal.input")
	chosen := func() any {
		t.Helper()
		reply := f.ask("command.run", input)
		if reply["result"] != "done" {
			t.Fatalf("the reply is %v", reply)
		}
		return f.forwards[len(f.forwards)-1]["surface"]
	}
	if got := chosen(); got != "tab-b" {
		t.Fatalf("the last registration was not chosen: %v", got)
	}
	f.preferred = []string{"tab-c", "tab-a"}
	if got := chosen(); got != "tab-a" {
		t.Fatalf("the first preferred surface that registered was not chosen: %v", got)
	}
	f.preferred = nil
	f.register("tab-a", "command", "terminal.input")
	if got := chosen(); got != "tab-a" {
		t.Fatalf("a repeated registration did not move the surface last: %v", got)
	}
	named := `{"name": "terminal.input", "params": {}, "surface": "tab-b"}`
	f.ask("command.run", named)
	last := f.forwards[len(f.forwards)-1]
	if last["surface"] != "tab-b" || last["method"] != "command.run" {
		t.Fatalf("the forward is %v", last)
	}
	if !reflect.DeepEqual(last["params"], map[string]any{"name": "terminal.input", "params": map[string]any{}, "surface": "tab-b"}) {
		t.Fatalf("the forward changed the params: %v", last["params"])
	}
	f.refuses(`{"name": "terminal.input", "params": {}, "surface": "tab-c"}`, workbench.Unregistered, "surface tab-c has not registered command terminal.input")
	f.refuses(`{"name": "terminal.input", "params": {}, "surface": 7}`, workbench.InvalidParams, "surface must be a string")
	f.unloaded["tab-c"] = true
	f.refuses(`{"name": "terminal.input", "params": {}, "surface": "tab-c"}`, workbench.Unregistered, "tab tab-c is unloaded")
	f.ask("command.run", `{"name": "terminal.input", "params": {}, "surface": "space/left/files"}`)
	if got := f.forwards[len(f.forwards)-1]["surface"]; got != "space/left/files" {
		t.Fatalf("a section that a request names was not chosen: %v", got)
	}
	if err := f.registry.Registered(workbench.SurfaceRegistered{Surface: "tab-a", Closed: true}); err != nil {
		t.Fatal(err)
	}
	if got := chosen(); got != "tab-b" {
		t.Fatalf("a closed surface was chosen: %v", got)
	}
	if err := f.registry.Registered(workbench.SurfaceRegistered{Surface: "tab-b", Closed: true}); err != nil {
		t.Fatal(err)
	}
	f.refuses(input, workbench.Unregistered, "command terminal.input is not registered")
}

func TestAForwardCarriesTheDeclaredTimeoutAndTheReplyOfTheSurface(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "command", "terminal.input")
	f.register("tab-a", "command", "terminal.close")
	f.ask("command.run", `{"name": "terminal.input", "params": {}}`)
	if _, present := f.forwards[0]["timeout"]; present {
		t.Fatalf("a command without a timeout forwarded %v", f.forwards[0])
	}
	f.ask("command.run", `{"name": "terminal.close", "params": {}}`)
	if f.forwards[1]["timeout"] != float64(2500) {
		t.Fatalf("the forward is %v", f.forwards[1])
	}
	if f.forwards[0]["id"] == f.forwards[1]["id"] {
		t.Fatal("two forwards have one id")
	}
	f.reply = func(map[string]any) (any, error) { return map[string]any{}, nil }
	if reply := f.ask("command.run", `{"name": "terminal.input", "params": {}}`); reply["result"] != nil {
		t.Fatalf("a reply without a result answered %v", reply)
	}
	f.reply = func(map[string]any) (any, error) {
		return map[string]any{"error": map[string]any{"code": 1005, "message": "no reply"}}, nil
	}
	f.refuses(`{"name": "terminal.input", "params": {}}`, 1005, "no reply")
	f.reply = func(map[string]any) (any, error) { return nil, errors.New("no window") }
	f.refuses(`{"name": "terminal.input", "params": {}}`, workbench.Failed, "no window")
}

func TestAForwardedCommandIsRecordedWhenItEnds(t *testing.T) {
	f := newSurfaceRequests(t)
	var names []string
	var failures []error
	f.registry.Record(func(name string, _ time.Duration, failure error) {
		names = append(names, name)
		failures = append(failures, failure)
	})
	f.register("tab-a", "command", "terminal.input")
	f.ask("command.run", `{"name": "terminal.input", "params": {}}`)
	f.reply = func(map[string]any) (any, error) {
		return map[string]any{"error": map[string]any{"code": 1002, "message": "gone"}}, nil
	}
	f.ask("command.run", `{"name": "terminal.input", "params": {}}`)
	if strings.Join(names, " ") != "terminal.input terminal.input" || failures[0] != nil || failures[1] == nil {
		t.Fatalf("recorded %v with %v", names, failures)
	}
}

func TestTheStatusAndTheElementOfASurfaceAreForwarded(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "status", "terminal.screen")
	f.register("tab-a", "dom", "terminal.view")
	f.reply = func(map[string]any) (any, error) { return map[string]any{"result": map[string]any{"rows": 2}}, nil }
	if got := f.ask("status.get", `{"name": "terminal.screen"}`)["result"]; !reflect.DeepEqual(got, map[string]any{"rows": float64(2)}) {
		t.Fatalf("the status is %v", got)
	}
	f.reply = func(map[string]any) (any, error) {
		return map[string]any{"result": map[string]any{"x": 3, "y": 4, "width": 10, "height": 20, "zoom": 1}}, nil
	}
	f.refuses2("dom.rect", `{"name": "terminal.view"}`, workbench.Failed, "surface tab-a has no valid applied frame")
	f.frames["tab-a"] = [2]float64{100, 50}
	want := map[string]any{"x": float64(103), "y": float64(54), "width": float64(10), "height": float64(20), "zoom": float64(1),
		"document": map[string]any{"x": float64(0), "y": float64(0)}}
	if got := f.ask("dom.rect", `{"name": "terminal.view"}`)["result"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("the rectangle is %v", got)
	}
	f.reply = func(map[string]any) (any, error) { return map[string]any{}, nil }
	if reply := f.ask("dom.act", `{"name": "terminal.view", "action": "click"}`); reply["result"] != nil {
		t.Fatalf("the action answered %v", reply)
	}
	if last := f.forwards[len(f.forwards)-1]; last["method"] != "dom.act" {
		t.Fatalf("the forward is %v", last)
	}
}

func (f *surfaceRequests) refuses2(method, params string, code int, message string) {
	f.t.Helper()
	got, text := f.refused(f.ask(method, params))
	if got != code || text != message {
		f.t.Fatalf("the refusal is %d %q, want %d %q", got, text, code, message)
	}
}

func (f *surfaceRequests) deliver(surface, name, value string, version int64) {
	f.t.Helper()
	f.registry.Deliver(workbench.SurfaceChange{Surface: surface, Name: name, Value: json.RawMessage(value), Version: version})
}

func TestAWatchOfASurfaceFollowsItsVersions(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "status", "terminal.screen")
	f.reply = func(request map[string]any) (any, error) {
		// The surface sends the current value as it starts the watch, before its reply.
		if request["method"] == "status.watch" {
			f.deliver("tab-a", "terminal.screen", `"first"`, 1)
		}
		return map[string]any{}, nil
	}
	if reply := f.ask("status.watch", `{"name": "terminal.screen"}`); reply["result"] != nil {
		t.Fatalf("the watch answered %v", reply)
	}
	if !reflect.DeepEqual(f.forwards[0]["params"], map[string]any{"name": "terminal.screen"}) {
		t.Fatalf("the watch forwarded %v", f.forwards[0])
	}
	if got := <-f.changes; got != `{"name":"terminal.screen","value":"first"}` {
		t.Fatalf("the change is %s", got)
	}
	f.deliver("tab-a", "terminal.screen", `"old"`, 1)
	f.deliver("tab-b", "terminal.screen", `"other"`, 9)
	f.deliver("tab-a", "terminal.screen", `"second"`, 2)
	if got := <-f.changes; got != `{"name":"terminal.screen","value":"second"}` {
		t.Fatalf("the change is %s", got)
	}
	f.ask("status.watch", `{"name": "terminal.screen"}`)
	if len(f.forwards) != 1 {
		t.Fatalf("a repeated watch forwarded %v", f.forwards)
	}
	// A second watch of a name that the surface follows receives from version 0, so it receives the current value again.
	f.ask("status.watch", `{"name": "terminal.screen", "surface": "tab-a"}`)
	if got := <-f.changes; got != `{"name":"terminal.screen","surface":"tab-a","value":"first"}` {
		t.Fatalf("the change is %s", got)
	}
	f.deliver("tab-a", "terminal.screen", `"third"`, 3)
	seen := map[string]bool{<-f.changes: true, <-f.changes: true}
	if !seen[`{"name":"terminal.screen","value":"third"}`] || !seen[`{"name":"terminal.screen","surface":"tab-a","value":"third"}`] {
		t.Fatalf("the changes are %v", seen)
	}
	f.ask("status.unwatch", `{"name": "terminal.screen"}`)
	if last := f.forwards[len(f.forwards)-1]; last["method"] == "status.unwatch" {
		t.Fatal("an unwatch ended the watch that another request shares")
	}
	f.ask("status.unwatch", `{"name": "terminal.screen", "surface": "tab-a"}`)
	if last := f.forwards[len(f.forwards)-1]; last["method"] != "status.unwatch" || !reflect.DeepEqual(last["params"], map[string]any{"name": "terminal.screen"}) {
		t.Fatalf("the forward is %v", last)
	}
	count := len(f.forwards)
	f.ask("status.unwatch", `{"name": "terminal.screen"}`)
	if len(f.forwards) != count {
		t.Fatalf("an unwatch of no watch forwarded %v", f.forwards[count:])
	}
	f.deliver("tab-a", "terminal.screen", `"late"`, 4)
	select {
	case got := <-f.changes:
		t.Fatalf("a value after the end of the watch reached the host: %s", got)
	default:
	}
}

func TestAWatchThatTheSurfaceRefusesEnds(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "status", "terminal.screen")
	f.reply = func(map[string]any) (any, error) {
		return map[string]any{"error": map[string]any{"code": 1002, "message": "no value"}}, nil
	}
	f.refuses2("status.watch", `{"name": "terminal.screen"}`, 1002, "no value")
	f.ask("status.watch", `{"name": "terminal.screen"}`)
	if len(f.forwards) != 2 {
		t.Fatalf("the refused watch stayed: %v", f.forwards)
	}
}

func TestAClosedSurfaceEndsItsWatches(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "status", "terminal.screen")
	f.reply = func(map[string]any) (any, error) { return map[string]any{}, nil }
	f.ask("status.watch", `{"name": "terminal.screen"}`)
	if err := f.registry.Registered(workbench.SurfaceRegistered{Surface: "tab-a", Closed: true}); err != nil {
		t.Fatal(err)
	}
	f.deliver("tab-a", "terminal.screen", `"late"`, 1)
	select {
	case got := <-f.changes:
		t.Fatalf("a closed surface reached the host: %s", got)
	default:
	}
	f.register("tab-a", "status", "terminal.screen")
	f.ask("status.watch", `{"name": "terminal.screen"}`)
	if len(f.forwards) != 2 {
		t.Fatalf("the watch of the closed surface stayed: %v", f.forwards)
	}
}

// last returns the last forward.
func (f *surfaceRequests) last() map[string]any {
	f.t.Helper()
	if len(f.forwards) == 0 {
		f.t.Fatal("no forward")
	}
	return f.forwards[len(f.forwards)-1]
}

func TestAControlOfASurfaceRunsItsCommandOnThatSurface(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "command", "terminal.input")
	f.register("tab-b", "command", "terminal.input")
	var result any
	var failure error
	f.registry.RunOn("terminal.input", nil, "tab-a", func(value any, err error) { result, failure = value, err })
	if failure != nil || string(result.(json.RawMessage)) != `"done"` {
		t.Fatalf("the run answered %v %v", result, failure)
	}
	if got := f.last(); got["surface"] != "tab-a" || !reflect.DeepEqual(got["params"], map[string]any{"name": "terminal.input", "params": map[string]any{}, "surface": "tab-a"}) {
		t.Fatalf("the forward is %v", got)
	}
	f.registry.RunOn("terminal.input", nil, "tab-c", func(_ any, err error) { failure = err })
	if failure == nil || failure.Error() != "surface tab-c has not registered command terminal.input" {
		t.Fatalf("the run gave %v", failure)
	}
}

func TestAViewRunsTheCommandsOfItsPlugin(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "command", "terminal.input")
	f.register("tab-b", "command", "terminal.input")
	f.register("space/left/files", "command", "terminal.input")
	run := func(surface, caller string) (any, error) {
		t.Helper()
		var surfaceOf any
		var failure error
		f.registry.RunOwned("terminal.input", json.RawMessage(`{"data": "x"}`), json.RawMessage(`["cid"]`), "terminal", surface, caller, func(_ any, err error) {
			failure = err
			if err == nil {
				surfaceOf = f.last()["surface"]
			}
		})
		return surfaceOf, failure
	}
	if got, err := run("tab-a", "tab-b"); err != nil || got != "tab-a" {
		t.Fatalf("a named surface gave %v %v", got, err)
	}
	if params := f.last()["params"].(map[string]any); !reflect.DeepEqual(params["cids"], []any{"cid"}) {
		t.Fatalf("the cause did not follow: %v", params)
	}
	if got, err := run("", "space/left/files"); err != nil || got != "space/left/files" {
		t.Fatalf("a section that runs its own command gave %v %v", got, err)
	}
	if got, err := run("", "tab-c"); err != nil || got != "tab-b" {
		t.Fatalf("a caller that did not register gave %v %v", got, err)
	}
	f.preferred = []string{"tab-a"}
	if got, err := run("", ""); err != nil || got != "tab-a" {
		t.Fatalf("the preferred surface gave %v %v", got, err)
	}
	if _, err := run("tab-c", ""); err == nil || err.Error() != "surface tab-c has not registered command terminal.input" {
		t.Fatalf("a surface of another plugin gave %v", err)
	}
	f.plugins = map[string]string{"tab-a": "browser", "tab-b": "browser"}
	if _, err := run("", ""); err == nil || err.Error() != "owner terminal has not registered command terminal.input" {
		t.Fatalf("no surface of the owner gave %v", err)
	}
}
