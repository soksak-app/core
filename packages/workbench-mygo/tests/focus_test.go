package workbench_test

import (
	"encoding/json"
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// focusView draws two elements of one name and one of another, each bound to focus as the binder does.
func focusView(focus *workbench.Focus) func(c *ui.Context) {
	return func(c *ui.Context) {
		focus.Frame(c)
		ui.Column(c).Children(func() {
			focus.Bind(ui.Button(c.Key("first"), "First").Size(100, 30), "core.tab")
			focus.Bind(ui.Button(c.Key("second"), "Second").Size(100, 30), "core.tab")
			focus.Bind(ui.Button(c.Key("save"), "Save").Size(100, 30), "core.save")
		})
	}
}

func focusValue(t *testing.T, focus *workbench.Focus) string {
	t.Helper()
	text, err := json.Marshal(focus.Status())
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func newFocus() *workbench.Focus {
	declared := &workbench.Declarations{Elements: map[string]bool{"core.tab": true, "core.save": true, "core.gone": true}}
	return workbench.NewFocus(declared, func() {})
}

func text(value string) *string { return &value }

// The status names the focused element and its index among the elements of its name, and follows the focus.
func TestFocusReportsTheFocusedElement(t *testing.T) {
	changes := 0
	focus := workbench.NewFocus(&workbench.Declarations{Elements: map[string]bool{"core.tab": true, "core.save": true}},
		func() { changes++ })
	tester := ui.NewTester(focusView(focus), 200, 200)
	tester.Frame()
	if got := focusValue(t, focus); got != "null" {
		t.Fatalf("the status before a focus is %s", got)
	}
	if err := tester.Click("Second"); err != nil {
		t.Fatal(err)
	}
	tester.Frame()
	if got, want := focusValue(t, focus), `{"name":"core.tab","index":1,"surface":null}`; got != want {
		t.Fatalf("the status is %s, want %s", got, want)
	}
	if changes == 0 {
		t.Fatal("a move of the focus reported no change")
	}
	before := changes
	tester.Frame()
	if changes != before {
		t.Fatal("a frame without a move of the focus reported a change")
	}
	tester.Key(0, ui.KeyTab)
	tester.Frame()
	if got, want := focusValue(t, focus), `{"name":"core.save","index":0,"surface":null}`; got != want {
		t.Fatalf("the status after Tab is %s, want %s", got, want)
	}
	tester.SetFocused(false)
	tester.Frame()
	if got := focusValue(t, focus); got != "null" {
		t.Fatalf("the status of a window without the keyboard is %s", got)
	}
}

// core.focus.set gives the keyboard focus to a named element, and refuses a name that is not declared and an index that no
// element has.
func TestFocusSetFocusesANamedElement(t *testing.T) {
	focus := newFocus()
	tester := ui.NewTester(focusView(focus), 200, 200)
	tester.Frame()
	if err := focus.Set("core.tab", 1); err != nil {
		t.Fatal(err)
	}
	tester.Frame()
	if !tester.Focused("Second") {
		t.Fatal("core.focus.set did not focus the second element of its name")
	}
	if got, want := focusValue(t, focus), `{"name":"core.tab","index":1,"surface":null}`; got != want {
		t.Fatalf("the status is %s, want %s", got, want)
	}
	for _, c := range []struct {
		name  string
		index int
		want  string
	}{
		{"core.unknown", 0, "unknown element core.unknown"},
		{"core.tab", 2, "element core.tab has no element at index 2"},
		{"core.gone", 0, "element core.gone has no element at index 0"},
	} {
		if err := focus.Set(c.name, c.index); err == nil || err.Error() != c.want {
			t.Fatalf("Set(%s, %d) failed with %v, want %s", c.name, c.index, err, c.want)
		}
	}
}

// The first responder selects the document whose element the status reports.
func TestFocusFollowsTheFirstResponder(t *testing.T) {
	focus := newFocus()
	tester := ui.NewTester(focusView(focus), 200, 200)
	tester.Frame()
	if err := tester.Click("Save"); err != nil {
		t.Fatal(err)
	}
	tester.Frame()
	workbenchFocus := `{"name":"core.save","index":0,"surface":null}`
	if got := focusValue(t, focus); got != workbenchFocus {
		t.Fatalf("the status before the first event is %s", got)
	}

	if err := focus.SetResponder(workbench.Responder{Owner: "surface", Surface: text("tab-1")}); err != nil {
		t.Fatal(err)
	}
	if got := focusValue(t, focus); got != "null" {
		t.Fatalf("a view that reported nothing has the status %s", got)
	}
	if err := focus.SetViewFocus("tab-1", json.RawMessage(`{"name":"view.field","index":2}`)); err != nil {
		t.Fatal(err)
	}
	if got, want := focusValue(t, focus), `{"name":"view.field","index":2,"surface":"tab-1"}`; got != want {
		t.Fatalf("the status is %s, want %s", got, want)
	}
	if err := focus.SetViewFocus("tab-1", json.RawMessage(`null`)); err != nil {
		t.Fatal(err)
	}
	if got := focusValue(t, focus); got != "null" {
		t.Fatalf("a view that reported null has the status %s", got)
	}
	if err := focus.SetViewFocus("tab-1", json.RawMessage(`{"name":"view.field","index":2}`)); err != nil {
		t.Fatal(err)
	}
	focus.ForgetView("tab-1")
	if got := focusValue(t, focus); got != "null" {
		t.Fatalf("a forgotten view has the status %s", got)
	}

	for _, owner := range []string{"document", "modal", "webview", "native"} {
		if err := focus.SetResponder(workbench.Responder{Owner: owner}); err != nil {
			t.Fatal(err)
		}
		if got := focusValue(t, focus); got != "null" {
			t.Fatalf("the owner %s has the status %s", owner, got)
		}
	}
	if err := focus.SetResponder(workbench.Responder{Owner: "workbench"}); err != nil {
		t.Fatal(err)
	}
	if got := focusValue(t, focus); got != workbenchFocus {
		t.Fatalf("the workbench has the status %s", got)
	}
}

// A value that is not {name, index} or null and an event without an owner are refused, and leave the state.
func TestFocusRefusesInvalidValues(t *testing.T) {
	focus := newFocus()
	for _, value := range []string{`{"name":"","index":0}`, `{"name":"a","index":-1}`, `{"name":"a"}`, `{"name":"a","index":1,"more":2}`, `"a"`, `{"name":"a","index":1.5}`} {
		want := "view call tab.focus requires {name, index} or null, not " + value
		if err := focus.SetViewFocus("tab-1", json.RawMessage(value)); err == nil || err.Error() != want {
			t.Fatalf("the value %s failed with %v", value, err)
		}
	}
	if err := focus.SetResponder(workbench.Responder{Surface: text("")}); err == nil ||
		err.Error() != `invalid window-responder event {"owner":"","surface":"","document":null}` {
		t.Fatalf("the event failed with %v", err)
	}
}

// core.focus.set reaches each kind of named element of the window, and the status names the element that has the focus.
func TestTheFocusCommandReachesTheElementsOfTheShell(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	type focused struct {
		Name  string `json:"name"`
		Index int    `json:"index"`
	}
	f.run("core.focus.set", map[string]any{"name": "core.chrome.settings"})
	f.settle()
	if got := status[*focused](t, f, "core.focus"); got == nil || got.Name != "core.chrome.settings" {
		t.Fatalf("the focus is %+v", got)
	}
	f.run("core.rename.begin", map[string]string{"kind": "project", "id": id})
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.rename.input"})
	f.settle()
	if got := status[*focused](t, f, "core.focus"); got == nil || got.Name != "core.rename.input" {
		t.Fatalf("the focus is %+v", got)
	}
}
