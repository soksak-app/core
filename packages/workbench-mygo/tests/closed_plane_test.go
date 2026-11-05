package workbench_test

import (
	"encoding/json"
	"testing"

	"github.com/egoist/mygo/ui"
)

// closeWithoutAFrame closes the shown project and draws no frame, so the elements of the last frame still take the input.
func closeWithoutAFrame(f *shellFixture) {
	f.t.Helper()
	raw, err := json.Marshal(map[string]string{"id": f.host.projects[0]["id"].(string)})
	if err != nil {
		f.t.Fatal(err)
	}
	var answered error
	done := false
	f.shell.Registry().RunLater("core.project.close", raw, func(_ any, err error) { answered, done = err, true })
	f.pending.drain(f.t)
	if !done || answered != nil {
		f.t.Fatalf("the close answered %v, done %t", answered, done)
	}
}

// The handlers of the last frame take input until the next frame draws, and a press there finds no plane.
func TestADividerTakesNoPressAfterItsProjectClosed(t *testing.T) {
	for _, clicks := range []int{1, 2} {
		f, left, right := splitShell(t)
		box, _ := f.divider(left, right)
		x, y := box.X+box.W/2, box.Y+box.H/2
		closeWithoutAFrame(f)
		if clicks == 2 {
			f.tester.ClickAt(x, y)
		}
		f.tester.Press(x, y)
		f.tester.Release(x, y)
		f.settle()
	}
}

// A hold of a boundary ends with its plane: a move and a release that follow find none.
func TestAHeldBoundaryEndsWithItsProject(t *testing.T) {
	f, left, right := splitShell(t)
	box, _ := f.divider(left, right)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.Move(x, y)
	f.tester.Frame()
	f.tester.Press(x, y)
	f.tester.Frame()
	closeWithoutAFrame(f)
	f.tester.Move(x-40, y)
	f.tester.Release(x-40, y)
	f.settle()
}

// A hold of a boundary ends with its plane when a change of space leaves it: the plane of the other space keeps its boundaries.
func TestAHeldBoundaryMovesNoBoundaryOfAnotherSpace(t *testing.T) {
	f, left, right := splitShell(t)
	first := f.host.projects[0]["activeSpaceId"].(string)
	f.answerText("core.space.add", nil)
	f.settle()
	second := f.host.projects[0]["activeSpaceId"].(string)
	made, err := f.answer("core.card.split", map[string]string{"card": f.tabbedCards()[0], "side": "right", "plugin": "terminal"})
	if err != nil {
		t.Fatal(err)
	}
	f.settle()
	f.run("core.space.activate", map[string]string{"id": first})
	box, _ := f.divider(left, right)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.Move(x, y)
	f.tester.Frame()
	f.tester.Press(x, y)
	f.tester.Frame()
	raw, err := json.Marshal(map[string]string{"id": second})
	if err != nil {
		t.Fatal(err)
	}
	f.shell.Registry().RunLater("core.space.activate", raw, func(any, error) {})
	f.pending.drain(t)
	f.settle()
	from := f.box("core.card", made["card"].(string))
	f.tester.Move(x-80, y)
	f.tester.Release(x-80, y)
	f.settle()
	if got := f.box("core.card", made["card"].(string)); got != from {
		t.Fatalf("the hold of the other space moved this card from %v to %v", from, got)
	}
}

// A focused divider takes no key once its plane left.
func TestAFocusedDividerTakesNoKeyAfterItsProjectClosed(t *testing.T) {
	f, left, right := splitShell(t)
	box, _ := f.divider(left, right)
	f.tester.ClickAt(box.X+box.W/2, box.Y+box.H/2)
	f.settle()
	from := f.box("core.card", left).W
	focused := false
	for range 80 {
		f.tester.Key(0, ui.KeyTab)
		f.settle()
		f.tester.Key(0, ui.KeyRight)
		f.settle()
		now := f.box("core.card", left).W
		if now == from+8 {
			focused = true
			break
		}
		// The stop on the boundary at the other side of the card, which the arrow moves into the card.
		if now == from-8 {
			f.tester.Key(0, ui.KeyLeft)
			f.settle()
		}
	}
	if !focused {
		t.Fatal("no Tab reached the divider")
	}
	closeWithoutAFrame(f)
	f.tester.Key(0, ui.KeyRight)
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
}

// A drag of a tab ends with its plane: a move and a release that follow find none.
func TestATabDragEndsWithItsProject(t *testing.T) {
	f, _, tab, other := cardWithTwoTabs(t)
	box := f.box("core.card", other)
	dragTab(t, f, tab, box.X+box.W/2, box.Y+box.H/2)
	closeWithoutAFrame(f)
	f.tester.Move(box.X+box.W/2+10, box.Y+box.H/2)
	f.tester.Release(box.X+box.W/2+10, box.Y+box.H/2)
	f.settle()
}

// A tab of the last frame starts no drag once its plane left.
func TestATabTakesNoPressAfterItsProjectClosed(t *testing.T) {
	f, _, tab, other := cardWithTwoTabs(t)
	box, target := f.box("core.card.tab", tab), f.box("core.card", other)
	closeWithoutAFrame(f)
	f.tester.Press(box.X+box.W/2, box.Y+box.H/2)
	f.tester.Move(target.X+target.W/2, target.Y+target.H/2)
	f.tester.Release(target.X+target.W/2, target.Y+target.H/2)
	f.settle()
}

// The answer of a save that outlived its project closes nothing and shows nothing: the tab is gone, as the close wanted.
func TestASaveThatOutlivesItsProjectShowsNoFailure(t *testing.T) {
	f := modifiedShell(t)
	f.viewCalled("tab-aaaaaa", "runtime.command.register", map[string]any{"name": "notes.save"})
	f.host.holdForwards = make(chan struct{})
	f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	save, ok := exposedNode(f.tester.ElementTree(), "core.picker.item", "save")
	if !ok {
		t.Fatal("no save item")
	}
	f.tester.ClickAt(save.Bounds.X+4, save.Bounds.Y+4)
	f.settle()
	closed := false
	f.shell.Registry().RunLater("core.project.close", json.RawMessage(`{"id":"`+f.host.projects[0]["id"].(string)+`"}`), func(_ any, err error) {
		if err != nil {
			t.Error(err)
		}
		closed = true
	})
	f.settle()
	discard, ok := exposedNode(f.tester.ElementTree(), "core.picker.item", "discard")
	if !ok {
		t.Fatal("no discard item")
	}
	f.tester.ClickAt(discard.Bounds.X+4, discard.Bounds.Y+4)
	f.settle()
	if !closed {
		t.Fatal("the project did not close")
	}
	close(f.host.holdForwards)
	f.host.holdForwards = nil
	f.settle()
	if shown := f.shownErrors(); len(shown) != 0 {
		t.Fatalf("the shell showed %q", shown)
	}
}

// A question about a tab leaves with the plane of that tab, so no answer comes after the plane and the tab stays.
func TestAQuestionLeavesWithThePlaneOfItsTab(t *testing.T) {
	f := modifiedShell(t)
	first := f.host.projects[0]["activeSpaceId"].(string)
	f.run(t, "core.space.add", `{}`)
	f.settle()
	f.run(t, "core.space.activate", `{"id":"`+first+`"}`)
	f.settle()
	second := ""
	for _, space := range f.host.projects[0]["spaces"].([]any) {
		if id := space.(map[string]any)["id"].(string); id != first {
			second = id
		}
	}
	f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	f.run(t, "core.space.activate", `{"id":"`+second+`"}`)
	f.settle()
	if _, ok := exposedNode(f.tester.ElementTree(), "core.picker.item", "discard"); ok {
		t.Fatal("the question stayed after the plane of its tab left")
	}
	f.run(t, "core.space.activate", `{"id":"`+first+`"}`)
	f.settle()
	if len(f.tabsOf("main")) != 2 {
		t.Fatalf("the tabs are %v", f.tabsOf("main"))
	}
}
