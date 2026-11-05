package workbench_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// renameRead is the status core.rename.
type renameRead struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Value string `json:"value"`
}

func storedTitle(f *shellFixture) string { return f.host.projects[0]["title"].(string) }

func storedSpaceTitle(f *shellFixture, id string) string {
	for _, space := range f.host.projects[0]["spaces"].([]any) {
		if record := space.(map[string]any); record["id"] == id {
			return record["title"].(string)
		}
	}
	return ""
}

// doubleClick presses the element twice.
func doubleClick(f *shellFixture, box ui.Rect) {
	f.tester.Advance(time.Second) // A press soon after the last one would count as a third click.
	x, y := box.X+box.W/2, box.Y+box.H/2
	for range 2 {
		f.tester.Move(x, y)
		f.tester.Frame()
		f.tester.ClickAt(x, y)
		f.tester.Frame()
	}
	f.tester.Frame()
}

// A double click on the tab of a project puts a field with the selected title in its place; typing replaces the title and Enter saves it.
func TestADoubleClickRenamesAProjectInPlace(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	doubleClick(f, f.box("core.project-tab", id))
	if got := status[*renameRead](t, f, "core.rename"); got == nil || got.Kind != "project" || got.ID != id || got.Value != storedTitle(f) {
		t.Fatalf("the rename is %+v", got)
	}
	if !f.has("core.rename.input", "") || f.has("core.project-tab", id) {
		t.Fatal("the field is not in the place of the tab")
	}
	f.tester.Type("beta")
	f.tester.Frame()
	if got := status[*renameRead](t, f, "core.rename"); got == nil || got.Value != "beta" {
		t.Fatalf("the rename is %+v after the typing", got)
	}
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if got := status[*renameRead](t, f, "core.rename"); got != nil {
		t.Fatalf("the rename stays as %+v", got)
	}
	if got := storedTitle(f); got != "beta" || !f.has("core.project-tab", id) {
		t.Fatalf("the title is %q", got)
	}
}

// Escape leaves the title as it was.
// The command that begins a rename hands the field the focus with its whole text selected, wherever the focus was, as a press does.
func TestABegunRenameHoldsTheFocus(t *testing.T) {
	f := openedShell(t)
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.space-tab.add"})
	f.settle()
	f.run("core.rename.begin", map[string]string{"kind": "project", "id": f.host.projects[0]["id"].(string)})
	f.settle()
	focus := status[*struct {
		Name string `json:"name"`
	}](t, f, "core.focus")
	if focus == nil || focus.Name != "core.rename.input" {
		t.Fatalf("the focus is %+v", focus)
	}
	f.tester.Type("x")
	f.settle()
	if got := status[*renameRead](t, f, "core.rename"); got == nil || got.Value != "x" {
		t.Fatalf("the rename is %+v", got)
	}
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if f.host.projects[0]["title"] != "x" {
		t.Fatalf("the store holds %v", f.host.projects[0]["title"])
	}
}

func TestEscapeStopsARename(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	was := storedTitle(f)
	doubleClick(f, f.box("core.project-tab", id))
	f.tester.Type("beta")
	f.tester.Frame()
	f.tester.Key(0, ui.KeyEscape)
	f.settle()
	if got := status[*renameRead](t, f, "core.rename"); got != nil || storedTitle(f) != was {
		t.Fatalf("the rename is %+v and the title %q", got, storedTitle(f))
	}
}

// A click elsewhere saves the name, and a name of only spaces keeps the old one.
func TestLosingTheFocusSavesARename(t *testing.T) {
	f := openedShell(t)
	f.run("core.space.add", nil)
	space := f.host.projects[0]["spaces"].([]any)[1].(map[string]any)["id"].(string)
	was := storedSpaceTitle(f, space)
	doubleClick(f, f.box("core.space-tab", space))
	if got := status[*renameRead](t, f, "core.rename"); got == nil || got.Kind != "space" {
		t.Fatalf("the rename is %+v", got)
	}
	f.tester.Type("   ")
	f.tester.Frame()
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if got := storedSpaceTitle(f, space); got != was {
		t.Fatalf("an empty name made the title %q", got)
	}
	doubleClick(f, f.box("core.space-tab", space))
	f.tester.Type("plan")
	f.tester.Frame()
	stage := f.box("core.space-tab.add", "")
	f.tester.ClickAt(stage.X+stage.W+200, stage.Y+stage.H/2)
	f.tester.Advance(100 * time.Millisecond)
	f.settle()
	if got := status[*renameRead](t, f, "core.rename"); got != nil || storedSpaceTitle(f, space) != "plan" {
		t.Fatalf("the rename is %+v and the title %q", got, storedSpaceTitle(f, space))
	}
}

func TestTheRenameCommandsRefuseWhatIsNotThere(t *testing.T) {
	f := openedShell(t)
	for _, refused := range []struct {
		command string
		params  any
		text    string
	}{
		{"core.rename.begin", map[string]string{"kind": "card", "id": "a"}, "unknown rename target card"},
		{"core.rename.begin", map[string]string{"kind": "project", "id": "absent"}, "no project absent"},
		{"core.rename.begin", map[string]string{"kind": "space", "id": "absent"}, "no space absent"},
		{"core.rename.set", map[string]string{"value": "x"}, "nothing is being renamed"},
		{"core.rename.commit", nil, "nothing is being renamed"},
		{"core.rename.cancel", nil, "nothing is being renamed"},
		{"core.project.rename", map[string]string{"id": "absent", "title": "x"}, "absent"},
		{"core.project.pin", map[string]any{"id": "absent", "pinned": true}, "absent"},
		{"core.space.rename", map[string]string{"id": "absent", "title": "x"}, "absent"},
	} {
		if _, err := f.answerLater(refused.command, refused.params); err == nil || !strings.Contains(err.Error(), refused.text) {
			t.Fatalf("%s %v answered %v", refused.command, refused.params, err)
		}
	}
}

// answerLater runs a command as the exposure does and returns its answer once the host calls are done.
func (f *shellFixture) answerLater(name string, params any) (any, error) {
	f.t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		f.t.Fatal(err)
	}
	var value any
	var failure error
	answered := false
	f.shell.Registry().RunLater(name, raw, func(got any, err error) { value, failure, answered = got, err, true })
	f.settle()
	if !answered {
		f.t.Fatalf("%s did not answer", name)
	}
	return value, failure
}

// A command of a project answers when the store holds the change, and the shell shows the change only then.
func TestAProjectCommandAnswersWhenTheStoreHoldsIt(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	for name, params := range map[string]any{
		"core.project.rename": map[string]string{"id": id, "title": "gamma"},
		"core.project.pin":    map[string]any{"id": id, "pinned": true},
		"core.library.pin":    map[string]any{"id": id, "pinned": false},
		"core.project.move":   map[string]any{"id": id, "delta": 0},
	} {
		raw, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		answered := false
		f.shell.Registry().RunLater(name, raw, func(_ any, err error) {
			if err != nil {
				t.Errorf("%s: %v", name, err)
			}
			answered = true
		})
		f.tester.Frame()
		if answered {
			t.Fatalf("%s answered before the store did", name)
		}
		f.settle()
		if !answered {
			t.Fatalf("%s did not answer after the store did", name)
		}
	}
	if got := storedTitle(f); got != "gamma" {
		t.Fatalf("the store holds the title %q", got)
	}
}

func TestTheCommandsOfAProjectChangeTheStore(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	space := f.host.projects[0]["spaces"].([]any)[0].(map[string]any)["id"].(string)
	f.answerLater("core.project.rename", map[string]string{"id": id, "title": "gamma"})
	f.run("core.space.rename", map[string]string{"id": space, "title": "plan"})
	f.answerLater("core.project.pin", map[string]any{"id": id, "pinned": true})
	f.settle()
	if storedTitle(f) != "gamma" || storedSpaceTitle(f, space) != "plan" || f.host.projects[0]["pinned"] != true {
		t.Fatalf("the store holds %v", f.host.projects[0])
	}
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/beta"})
	f.run("core.library.form.submit", nil)
	f.settle()
	other := f.host.projects[1]["id"].(string)
	f.answerLater("core.project.move", map[string]any{"id": other, "delta": -1})
	f.settle()
	if f.host.projects[0]["id"] != other {
		t.Fatalf("the store holds %v first", f.host.projects[0]["id"])
	}
	f.answerLater("core.project.move", map[string]any{"id": other, "delta": -1}) // Past the end nothing moves.
	f.settle()
	if f.host.projects[0]["id"] != other {
		t.Fatalf("the store holds %v first", f.host.projects[0]["id"])
	}
}

// A project tab that is dropped on another tab moves its project to the place of that tab.
func TestAProjectTabDraggedToAnotherMovesItsProject(t *testing.T) {
	f, alpha, beta := libraryOfTwoProjects(t)
	f.run("core.library.return", nil)
	f.settle()
	first, second := f.box("core.project-tab", alpha), f.box("core.project-tab", beta)
	from, at := first.X+first.W/2, first.Y+first.H/2
	f.tester.Move(from, at)
	f.tester.Frame()
	f.tester.Press(from, at)
	f.tester.Frame()
	f.tester.Move(second.X+second.W/2, at)
	f.tester.Frame()
	f.tester.Release(second.X+second.W/2, at)
	f.settle()
	if got := f.host.projects[0]["id"]; got != beta {
		t.Fatalf("the first project is %v, the order did not change", got)
	}
	if got := status[map[string]any](t, f, "core.project"); got["id"] != beta {
		t.Fatalf("the drag activated %v", got["id"])
	}
	// A press that stays on its tab activates its project and moves nothing.
	moved := f.box("core.project-tab", alpha)
	f.tester.ClickAt(moved.X+moved.W/2, moved.Y+moved.H/2)
	f.settle()
	if got := status[map[string]any](t, f, "core.project"); got["id"] != alpha || f.host.projects[0]["id"] != beta {
		t.Fatalf("the click left %v active over %v", got["id"], f.host.projects[0]["id"])
	}
}

// A double click reads as the same pointer sequence as on a page: its release lands on the tab, which the rename replaces after it.
func TestADoubleClickEndsItsPointerSequenceOnTheTab(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	box := f.box("core.project-tab", id)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.Advance(time.Second)
	f.tester.Move(x, y)
	f.tester.Frame()
	for range 2 {
		f.tester.Press(x, y)
		f.tester.Frame()
		f.tester.Release(x, y)
		f.tester.Frame()
	}
	got := status[workbench.PointerStatus](t, f, "core.pointer")
	text := func(value *string) string {
		if value == nil {
			return "null"
		}
		return *value
	}
	t.Logf("down %s up %s click %s", text(got.Down), text(got.Up), text(got.Click))
	if text(got.Down) != "core.project-tab" || text(got.Up) != "core.project-tab" || text(got.Click) != "core.project-tab" {
		t.Fatalf("the sequence is down %s, up %s, click %s", text(got.Down), text(got.Up), text(got.Click))
	}
}

// A second press that drags away from the tab is no double click, and the click after it starts no rename.
func TestASecondPressThatLeavesTheTabRenamesNothing(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	box := f.box("core.project-tab", id)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.Advance(time.Second)
	f.tester.Move(x, y)
	f.tester.Frame()
	f.tester.ClickAt(x, y)
	f.tester.Frame()
	f.tester.Press(x, y)
	f.tester.Frame()
	f.tester.Move(x+box.W*3, y+box.H*12)
	f.tester.Frame()
	f.tester.Release(x+box.W*3, y+box.H*12)
	f.tester.Frame()
	f.settle()
	if got := status[*renameRead](t, f, "core.rename"); got != nil {
		t.Fatalf("the rename is %+v after a press that left the tab", got)
	}
	f.tester.Advance(time.Second)
	f.tester.Move(x, y)
	f.tester.Frame()
	f.tester.ClickAt(x, y)
	f.settle()
	if got := status[*renameRead](t, f, "core.rename"); got != nil {
		t.Fatalf("the rename is %+v after one click", got)
	}
}
