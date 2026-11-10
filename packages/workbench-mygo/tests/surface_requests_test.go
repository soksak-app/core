// The requests for the names that surfaces register: the declarations of the plugins, the surfaces that registered each name, the
// choice of a surface, the forwards to it and the values of its watched statuses, as docs/spec/exposure.md gives them to the main page.
package workbench_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// terminalExposes are the declarations of a plugin with a status, two commands and an element.
func terminalExposes() workbench.Exposes {
	return workbench.Exposes{
		Status:   []json.RawMessage{json.RawMessage(`{"name": "textprobe.screen"}`)},
		Commands: []json.RawMessage{json.RawMessage(`{"name": "textprobe.input"}`), json.RawMessage(`{"name": "textprobe.close"}`)},
		Element:  []json.RawMessage{json.RawMessage(`{"name": "textprobe.view"}`)},
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
	behind    bool
	links     workbench.SurfaceLinks
}

func newSurfaceRequests(t *testing.T) *surfaceRequests {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	f := &surfaceRequests{registry: workbench.NewRegistry(declared), plugins: map[string]string{"tab-a": "textprobe", "tab-b": "textprobe", "tab-c": "boxprobe",
		"space/left/fieldprobe": "textprobe"}, frames: map[string][2]float64{}, unloaded: map[string]bool{}}
	f.relay = newRelay(t, f.registry)
	f.reply = func(map[string]any) (any, error) { return map[string]any{"result": "done"}, nil }
	if err := f.registry.Declare("textprobe", terminalExposes()); err != nil {
		t.Fatal(err)
	}
	f.links = workbench.SurfaceLinks{
		Plugin:       func(surface string) string { return f.plugins[surface] },
		Preferred:    func() []string { return f.preferred },
		Unloaded:     func(surface string) bool { return f.unloaded[surface] },
		BehindDialog: func() bool { return f.behind },
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
		Failed: func(err error) { t.Error(err) },
	}
	f.registry.Link(f.links)
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
	foreign := workbench.Exposes{Commands: []json.RawMessage{json.RawMessage(`{"name": "boxprobe.go"}`)}}
	if err := f.registry.Declare("textprobe", foreign); err == nil || err.Error() != "command boxprobe.go does not belong to textprobe" {
		t.Fatalf("the foreign name gave %v", err)
	}
	if err := f.registry.Declare("textprobe", terminalExposes()); err == nil || err.Error() != "status textprobe.screen is declared twice" {
		t.Fatalf("the second declaration gave %v", err)
	}
	if err := f.registry.Declare("textprobe", workbench.Exposes{Status: []json.RawMessage{json.RawMessage(`{}`)}}); err == nil {
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
	if registered("commands", "textprobe.input") || registered("status", "textprobe.screen") || registered("element", "textprobe.view") {
		t.Fatal("a name that no surface registered is registered")
	}
	f.register("tab-a", "command", "textprobe.input")
	f.register("tab-a", "status", "textprobe.screen")
	f.register("tab-a", "element", "textprobe.view")
	if !registered("commands", "textprobe.input") || !registered("status", "textprobe.screen") || !registered("element", "textprobe.view") {
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
		{workbench.SurfaceRegistered{Surface: "tab-a", Kind: "command", Name: "textprobe.none"}, "surface tab-a registered undeclared command textprobe.none"},
		{workbench.SurfaceRegistered{Surface: "tab-a", Kind: "command", Name: "core.card.split"}, "surface tab-a registered undeclared command core.card.split"},
		{workbench.SurfaceRegistered{Surface: "tab-c", Kind: "command", Name: "textprobe.input"}, "surface tab-c of plugin boxprobe cannot register textprobe.input"},
	}
	for _, each := range cases {
		if err := f.registry.Registered(each.event); err == nil || err.Error() != each.text {
			t.Fatalf("%v gave %v", each.event, err)
		}
	}
	// The registration of a surface that the window closed meanwhile names no surface, and its end follows.
	if err := f.registry.Registered(workbench.SurfaceRegistered{Surface: "tab-gone", Kind: "command", Name: "textprobe.input"}); err != nil {
		t.Fatal(err)
	}
	f.refuses(`{"name": "textprobe.input", "params": {}}`, workbench.Unregistered, "command textprobe.input is not registered")
}

func TestARequestChoosesTheSurfaceOfItsName(t *testing.T) {
	f := newSurfaceRequests(t)
	input := `{"name": "textprobe.input", "params": {"data": "x"}}`
	f.refuses(`{"name": "textprobe.none", "params": {}}`, workbench.UnknownName, "unknown command textprobe.none")
	f.refuses(input, workbench.Unregistered, "command textprobe.input is not registered")
	f.register("space/left/fieldprobe", "command", "textprobe.input")
	f.refuses(input, workbench.Unregistered, "command textprobe.input is not registered")
	f.register("tab-a", "command", "textprobe.input")
	f.register("tab-b", "command", "textprobe.input")
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
	f.register("tab-a", "command", "textprobe.input")
	if got := chosen(); got != "tab-a" {
		t.Fatalf("a repeated registration did not move the surface last: %v", got)
	}
	named := `{"name": "textprobe.input", "params": {}, "surface": "tab-b"}`
	f.ask("command.run", named)
	last := f.forwards[len(f.forwards)-1]
	if last["surface"] != "tab-b" || last["method"] != "command.run" {
		t.Fatalf("the forward is %v", last)
	}
	if !reflect.DeepEqual(last["params"], map[string]any{"name": "textprobe.input", "params": map[string]any{}, "surface": "tab-b"}) {
		t.Fatalf("the forward changed the params: %v", last["params"])
	}
	f.refuses(`{"name": "textprobe.input", "params": {}, "surface": "tab-c"}`, workbench.Unregistered, "surface tab-c has not registered command textprobe.input")
	f.refuses(`{"name": "textprobe.input", "params": {}, "surface": 7}`, workbench.InvalidParams, "surface must be a string")
	f.unloaded["tab-c"] = true
	f.refuses(`{"name": "textprobe.input", "params": {}, "surface": "tab-c"}`, workbench.Unregistered, "tab tab-c is unloaded")
	f.ask("command.run", `{"name": "textprobe.input", "params": {}, "surface": "space/left/fieldprobe"}`)
	if got := f.forwards[len(f.forwards)-1]["surface"]; got != "space/left/fieldprobe" {
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
	f.refuses(input, workbench.Unregistered, "command textprobe.input is not registered")
}

// A forward carries no time limit: it ends by the reply of the surface.
func TestAForwardCarriesNoTimeoutAndTheReplyOfTheSurface(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "command", "textprobe.input")
	f.register("tab-a", "command", "textprobe.close")
	f.ask("command.run", `{"name": "textprobe.input", "params": {}}`)
	f.ask("command.run", `{"name": "textprobe.close", "params": {}}`)
	for _, forward := range f.forwards {
		if _, present := forward["timeout"]; present {
			t.Fatalf("a forward carries a time limit: %v", forward)
		}
	}
	if f.forwards[0]["id"] == f.forwards[1]["id"] {
		t.Fatal("two forwards have one id")
	}
	f.reply = func(map[string]any) (any, error) { return map[string]any{}, nil }
	if reply := f.ask("command.run", `{"name": "textprobe.input", "params": {}}`); reply["result"] != nil {
		t.Fatalf("a reply without a result answered %v", reply)
	}
	f.reply = func(map[string]any) (any, error) {
		return map[string]any{"error": map[string]any{"code": 1005, "message": "no reply"}}, nil
	}
	f.refuses(`{"name": "textprobe.input", "params": {}}`, 1005, "no reply")
	f.reply = func(map[string]any) (any, error) { return nil, errors.New("no window") }
	f.refuses(`{"name": "textprobe.input", "params": {}}`, workbench.Failed, "no window")
}

func TestAForwardedCommandIsRecordedWhenItEnds(t *testing.T) {
	f := newSurfaceRequests(t)
	var names []string
	var failures []error
	f.registry.Record(func(name string, _ time.Duration, failure error) {
		names = append(names, name)
		failures = append(failures, failure)
	})
	f.register("tab-a", "command", "textprobe.input")
	f.ask("command.run", `{"name": "textprobe.input", "params": {}}`)
	f.reply = func(map[string]any) (any, error) {
		return map[string]any{"error": map[string]any{"code": 1002, "message": "gone"}}, nil
	}
	f.ask("command.run", `{"name": "textprobe.input", "params": {}}`)
	if strings.Join(names, " ") != "textprobe.input textprobe.input" || failures[0] != nil || failures[1] == nil {
		t.Fatalf("recorded %v with %v", names, failures)
	}
}

func TestTheStatusAndTheElementOfASurfaceAreForwarded(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "status", "textprobe.screen")
	f.register("tab-a", "element", "textprobe.view")
	f.reply = func(map[string]any) (any, error) { return map[string]any{"result": map[string]any{"rows": 2}}, nil }
	if got := f.ask("status.get", `{"name": "textprobe.screen"}`)["result"]; !reflect.DeepEqual(got, map[string]any{"rows": float64(2)}) {
		t.Fatalf("the status is %v", got)
	}
	f.reply = func(map[string]any) (any, error) {
		return map[string]any{"result": map[string]any{"x": 3, "y": 4, "width": 10, "height": 20, "zoom": 1}}, nil
	}
	f.refuses2("element.rect", `{"name": "textprobe.view"}`, workbench.Failed, "surface tab-a has no valid applied frame")
	f.frames["tab-a"] = [2]float64{100, 50}
	want := map[string]any{"x": float64(103), "y": float64(54), "width": float64(10), "height": float64(20), "zoom": float64(1),
		"document": map[string]any{"x": float64(0), "y": float64(0)}}
	if got := f.ask("element.rect", `{"name": "textprobe.view"}`)["result"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("the rectangle is %v", got)
	}
	f.reply = func(map[string]any) (any, error) { return map[string]any{}, nil }
	if reply := f.ask("element.act", `{"name": "textprobe.view", "action": "click"}`); reply["result"] != nil {
		t.Fatalf("the action answered %v", reply)
	}
	if last := f.forwards[len(f.forwards)-1]; last["method"] != "element.act" {
		t.Fatalf("the forward is %v", last)
	}
}

// An open dialog stands over a surface: the rectangle stays and an action does not reach the surface (docs/spec/exposure.md).
func TestAnOpenDialogRefusesAnActionOnASurfaceElementAndKeepsItsPlace(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "element", "textprobe.view")
	f.frames["tab-a"] = [2]float64{100, 50}
	f.reply = func(map[string]any) (any, error) {
		return map[string]any{"result": map[string]any{"x": 3, "y": 4, "width": 10, "height": 20, "zoom": 1}}, nil
	}
	f.behind = true
	if got := f.ask("element.rect", `{"name": "textprobe.view"}`)["result"].(map[string]any); got["x"] != float64(103) || got["y"] != float64(54) {
		t.Fatalf("the rectangle is %v", got)
	}
	forwards := len(f.forwards)
	f.refuses2("element.act", `{"name": "textprobe.view", "action": "click"}`, 1010, "element textprobe.view is behind the open dialog and takes no action")
	if len(f.forwards) != forwards {
		t.Fatalf("the action reached the surface: %v", f.forwards[len(f.forwards)-1])
	}
	f.behind = false
	f.reply = func(map[string]any) (any, error) { return map[string]any{}, nil }
	if reply := f.ask("element.act", `{"name": "textprobe.view", "action": "click"}`); reply["error"] != nil {
		t.Fatalf("after the dialog the action answered %v", reply)
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
	f.register("tab-a", "status", "textprobe.screen")
	f.reply = func(request map[string]any) (any, error) {
		// The surface sends the current value as it starts the watch, before its reply.
		if request["method"] == "status.watch" {
			f.deliver("tab-a", "textprobe.screen", `"first"`, 1)
		}
		return map[string]any{}, nil
	}
	if reply := f.ask("status.watch", `{"name": "textprobe.screen"}`); reply["result"] != nil {
		t.Fatalf("the watch answered %v", reply)
	}
	if !reflect.DeepEqual(f.forwards[0]["params"], map[string]any{"name": "textprobe.screen"}) {
		t.Fatalf("the watch forwarded %v", f.forwards[0])
	}
	if got := <-f.changes; got != `{"name":"textprobe.screen","value":"first"}` {
		t.Fatalf("the change is %s", got)
	}
	f.deliver("tab-a", "textprobe.screen", `"old"`, 1)
	f.deliver("tab-b", "textprobe.screen", `"other"`, 9)
	f.deliver("tab-a", "textprobe.screen", `"second"`, 2)
	if got := <-f.changes; got != `{"name":"textprobe.screen","value":"second"}` {
		t.Fatalf("the change is %s", got)
	}
	f.ask("status.watch", `{"name": "textprobe.screen"}`)
	if len(f.forwards) != 1 {
		t.Fatalf("a repeated watch forwarded %v", f.forwards)
	}
	// A second watch of a name that the surface follows receives from version 0, so it receives the current value again.
	f.ask("status.watch", `{"name": "textprobe.screen", "surface": "tab-a"}`)
	if got := <-f.changes; got != `{"name":"textprobe.screen","surface":"tab-a","value":"first"}` {
		t.Fatalf("the change is %s", got)
	}
	f.deliver("tab-a", "textprobe.screen", `"third"`, 3)
	seen := map[string]bool{<-f.changes: true, <-f.changes: true}
	if !seen[`{"name":"textprobe.screen","value":"third"}`] || !seen[`{"name":"textprobe.screen","surface":"tab-a","value":"third"}`] {
		t.Fatalf("the changes are %v", seen)
	}
	f.ask("status.unwatch", `{"name": "textprobe.screen"}`)
	if last := f.forwards[len(f.forwards)-1]; last["method"] == "status.unwatch" {
		t.Fatal("an unwatch ended the watch that another request shares")
	}
	f.ask("status.unwatch", `{"name": "textprobe.screen", "surface": "tab-a"}`)
	if last := f.forwards[len(f.forwards)-1]; last["method"] != "status.unwatch" || !reflect.DeepEqual(last["params"], map[string]any{"name": "textprobe.screen"}) {
		t.Fatalf("the forward is %v", last)
	}
	count := len(f.forwards)
	f.ask("status.unwatch", `{"name": "textprobe.screen"}`)
	if len(f.forwards) != count {
		t.Fatalf("an unwatch of no watch forwarded %v", f.forwards[count:])
	}
	f.deliver("tab-a", "textprobe.screen", `"late"`, 4)
	select {
	case got := <-f.changes:
		t.Fatalf("a value after the end of the watch reached the host: %s", got)
	default:
	}
}

func TestAWatchThatTheSurfaceRefusesEnds(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "status", "textprobe.screen")
	f.reply = func(map[string]any) (any, error) {
		return map[string]any{"error": map[string]any{"code": 1002, "message": "no value"}}, nil
	}
	f.refuses2("status.watch", `{"name": "textprobe.screen"}`, 1002, "no value")
	f.ask("status.watch", `{"name": "textprobe.screen"}`)
	if len(f.forwards) != 2 {
		t.Fatalf("the refused watch stayed: %v", f.forwards)
	}
}

func TestAClosedSurfaceEndsItsWatches(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "status", "textprobe.screen")
	f.reply = func(map[string]any) (any, error) { return map[string]any{}, nil }
	f.ask("status.watch", `{"name": "textprobe.screen"}`)
	if err := f.registry.Registered(workbench.SurfaceRegistered{Surface: "tab-a", Closed: true}); err != nil {
		t.Fatal(err)
	}
	f.deliver("tab-a", "textprobe.screen", `"late"`, 1)
	select {
	case got := <-f.changes:
		t.Fatalf("a closed surface reached the host: %s", got)
	default:
	}
	f.register("tab-a", "status", "textprobe.screen")
	f.ask("status.watch", `{"name": "textprobe.screen"}`)
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
	f.register("tab-a", "command", "textprobe.input")
	f.register("tab-b", "command", "textprobe.input")
	var result any
	var failure error
	f.registry.RunOn("textprobe.input", nil, "tab-a", func(value any, err error) { result, failure = value, err })
	if failure != nil || string(result.(json.RawMessage)) != `"done"` {
		t.Fatalf("the run answered %v %v", result, failure)
	}
	if got := f.last(); got["surface"] != "tab-a" || !reflect.DeepEqual(got["params"], map[string]any{"name": "textprobe.input", "params": map[string]any{}, "surface": "tab-a"}) {
		t.Fatalf("the forward is %v", got)
	}
	f.registry.RunOn("textprobe.input", nil, "tab-c", func(_ any, err error) { failure = err })
	if failure == nil || failure.Error() != "surface tab-c has not registered command textprobe.input" {
		t.Fatalf("the run gave %v", failure)
	}
}

func TestAViewRunsTheCommandsOfItsPlugin(t *testing.T) {
	f := newSurfaceRequests(t)
	f.register("tab-a", "command", "textprobe.input")
	f.register("tab-b", "command", "textprobe.input")
	f.register("space/left/fieldprobe", "command", "textprobe.input")
	run := func(surface, caller string) (any, error) {
		t.Helper()
		var surfaceOf any
		var failure error
		f.registry.RunOwned("textprobe.input", json.RawMessage(`{"data": "x"}`), json.RawMessage(`["cid"]`), "textprobe", surface, caller, func(_ any, err error) {
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
	if got, err := run("", "space/left/fieldprobe"); err != nil || got != "space/left/fieldprobe" {
		t.Fatalf("a section that runs its own command gave %v %v", got, err)
	}
	if got, err := run("", "tab-c"); err != nil || got != "tab-b" {
		t.Fatalf("a caller that did not register gave %v %v", got, err)
	}
	f.preferred = []string{"tab-a"}
	if got, err := run("", ""); err != nil || got != "tab-a" {
		t.Fatalf("the preferred surface gave %v %v", got, err)
	}
	if _, err := run("tab-c", ""); err == nil || err.Error() != "surface tab-c has not registered command textprobe.input" {
		t.Fatalf("a surface of another plugin gave %v", err)
	}
	f.plugins = map[string]string{"tab-a": "boxprobe", "tab-b": "boxprobe"}
	if _, err := run("", ""); err == nil || err.Error() != "owner textprobe has not registered command textprobe.input" {
		t.Fatalf("no surface of the owner gave %v", err)
	}
}

func TestAnObserverFollowsTheSurfaceThatHoldsTheStatus(t *testing.T) {
	f := newSurfaceRequests(t)
	f.reply = func(map[string]any) (any, error) { return map[string]any{}, nil }
	var values []any
	stop := f.registry.Observe("textprobe.screen", nil, false, func(value any) { values = append(values, value) })
	if len(values) != 1 || values[0] != nil {
		t.Fatalf("an observer without a surface received %v", values)
	}
	f.register("tab-a", "status", "textprobe.screen")
	if last := f.last(); last["method"] != "status.watch" || last["surface"] != "tab-a" {
		t.Fatalf("the forward is %v", last)
	}
	f.deliver("tab-a", "textprobe.screen", `"one"`, 1)
	if len(values) != 2 || string(values[1].(json.RawMessage)) != `"one"` {
		t.Fatalf("the observer received %v", values)
	}
	select {
	case got := <-f.changes:
		t.Fatalf("a value that only this window watches reached the host: %s", got)
	default:
	}
	// A request of the host that names the surface shares the watch and stays after an unwatch of nothing else.
	f.ask("status.watch", `{"name": "textprobe.screen", "surface": "tab-a"}`)
	if len(f.forwards) != 1 {
		t.Fatalf("the shared watch forwarded %v", f.forwards)
	}
	f.ask("status.unwatch", `{"name": "textprobe.screen", "surface": "tab-a"}`)
	if len(f.forwards) != 1 {
		t.Fatalf("the unwatch ended the watch of the observer: %v", f.forwards)
	}
	f.register("tab-b", "status", "textprobe.screen")
	if len(f.forwards) != 3 || f.forwards[1]["method"] != "status.unwatch" || f.forwards[1]["surface"] != "tab-a" ||
		f.forwards[2]["method"] != "status.watch" || f.forwards[2]["surface"] != "tab-b" {
		t.Fatalf("the watch did not move: %v", f.forwards)
	}
	if err := f.registry.Registered(workbench.SurfaceRegistered{Surface: "tab-b", Closed: true}); err != nil {
		t.Fatal(err)
	}
	if last := f.last(); last["surface"] != "tab-a" || last["method"] != "status.watch" {
		t.Fatalf("the observer stayed on a closed surface: %v", last)
	}
	stop()
	if last := f.last(); last["surface"] != "tab-a" || last["method"] != "status.unwatch" {
		t.Fatalf("the end of the observer forwarded %v", last)
	}
	count := len(values)
	f.deliver("tab-a", "textprobe.screen", `"late"`, 9)
	if len(values) != count {
		t.Fatalf("an ended observer received %v", values)
	}
}

func TestAnExactObserverFollowsOnlyItsSurface(t *testing.T) {
	f := newSurfaceRequests(t)
	f.reply = func(map[string]any) (any, error) { return map[string]any{}, nil }
	wanted := "tab-b"
	var values []any
	f.register("tab-a", "status", "textprobe.screen")
	f.registry.Observe("textprobe.screen", &wanted, true, func(value any) { values = append(values, value) })
	if len(f.forwards) != 0 || len(values) != 1 || values[0] != nil {
		t.Fatalf("the observer followed another surface: %v %v", f.forwards, values)
	}
	f.register("tab-b", "status", "textprobe.screen")
	if last := f.last(); last["surface"] != "tab-b" {
		t.Fatalf("the forward is %v", last)
	}
}

func TestAFailedObservationIsReported(t *testing.T) {
	f := newSurfaceRequests(t)
	var failures []string
	links := f.links
	links.Failed = func(err error) { failures = append(failures, err.Error()) }
	f.registry.Link(links)
	f.register("tab-a", "status", "textprobe.screen")
	f.reply = func(map[string]any) (any, error) {
		return map[string]any{"error": map[string]any{"code": workbench.Gone, "message": "ended"}}, nil
	}
	stop := f.registry.Observe("textprobe.screen", nil, false, func(any) {})
	stop()
	f.reply = func(map[string]any) (any, error) {
		return map[string]any{"error": map[string]any{"code": workbench.Failed, "message": "no value"}}, nil
	}
	f.registry.Observe("textprobe.screen", nil, false, func(any) {})
	if len(failures) != 1 || failures[0] != "textprobe.screen on tab-a: no value" {
		t.Fatalf("the failures are %v", failures)
	}
}

// The window holds what the plugins wrote, so the registry keeps those bytes and decodes them when a listing asks.
func TestTheRegistryHoldsNoCopyOfTheDeclarations(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	exposes := workbench.Exposes{}
	written := 0
	for i := range 1000 {
		raw := json.RawMessage(fmt.Sprintf(`{"name": "textprobe.command-%d", "description": %q, "params": {"type": "object",
			"properties": {"surface": {"type": "string"}, "text": {"type": "string"}}}}`, i, strings.Repeat("word ", 40)))
		exposes.Commands = append(exposes.Commands, raw)
		written += len(raw)
	}
	n := heldBytes(func() any {
		registry := workbench.NewRegistry(declared)
		if err := registry.Declare("textprobe", exposes); err != nil {
			t.Fatal(err)
		}
		return registry
	})
	runtime.KeepAlive(exposes)
	if n > uint64(written) {
		t.Errorf("the registry holds %d kB for %d kB of declarations", n>>10, written>>10)
	}
}

// A command declaration with timeout is refused, and nothing of its declarations is added.
func TestACommandDeclarationWithATimeoutIsRefused(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	for _, timeout := range []string{"1", "10000", "600000", "0", `"100"`} {
		registry := workbench.NewRegistry(declared)
		err := registry.Declare("textprobe", workbench.Exposes{
			Status:   []json.RawMessage{json.RawMessage(`{"name": "textprobe.screen"}`)},
			Commands: []json.RawMessage{json.RawMessage(`{"name": "textprobe.close", "timeout": ` + timeout + `}`)},
		})
		if err == nil || err.Error() != "textprobe exposes textprobe.close: timeout is not a member of a command declaration" {
			t.Fatalf("a declaration with timeout %s gave %v", timeout, err)
		}
		if err := registry.Declare("textprobe", workbench.Exposes{Status: []json.RawMessage{json.RawMessage(`{"name": "textprobe.screen"}`)}}); err != nil {
			t.Fatalf("the refused declaration with timeout %s kept a status: %v", timeout, err)
		}
	}
}
