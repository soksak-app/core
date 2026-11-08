package workbench_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime/debug"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// closeWithoutAFrame closes the shown project and draws no frame, so the elements of the last frame still take the input. The
// close answers after the frame that shows the library (docs/spec/exposure.md#registration), so without a frame it has not
// answered; the screen states the close.
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
	if done {
		f.t.Fatalf("the close answered %v before a frame showed it", answered)
	}
	screen, err := f.shell.Registry().Read("core.screen")
	if err != nil {
		f.t.Fatal(err)
	}
	if text, err := json.Marshal(screen); err != nil || !strings.Contains(string(text), `"screen":"library"`) {
		f.t.Fatalf("after the close the screen is %s (%v)", text, err)
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
	made, err := f.answer("core.card.split", map[string]string{"card": f.tabbedCards()[0], "side": "right", "plugin": "textprobe"})
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

// saveOutlivesItsProject starts a save of a modified tab, closes its project while the view saves and lets the view answer.
func saveOutlivesItsProject(t *testing.T, f *tabShell, name, params string) {
	t.Helper()
	f.viewCalled("tab-aaaaaa", "runtime.command.register", map[string]any{"name": "notes.save"})
	f.host.holdForwards = make(chan struct{})
	f.run(t, name, params)
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
}

// A save that succeeds after its project closed has nothing left to close and nothing to show.
func TestASaveThatOutlivesItsProjectShowsNoFailure(t *testing.T) {
	f := modifiedShell(t)
	saveOutlivesItsProject(t, f, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	if shown := f.shownErrors(); len(shown) != 0 {
		t.Fatalf("the shell showed %q", shown)
	}
}

// The close of a card goes on to the next tab after an answer, and reads the plane to do it. A save that outlived the plane
// settles nothing, so the close stops before that read and the plane that left is not read.
func TestACardCloseEndsWithASaveThatOutlivesItsProject(t *testing.T) {
	f := modifiedShell(t)
	f.run(t, "core.card.split", `{"card":"main","side":"right","plugin":"notes"}`)
	f.settle()
	saveOutlivesItsProject(t, f, "core.card.close", `{"card":"main"}`)
	f.settle()
	if shown := f.shownErrors(); len(shown) != 0 {
		t.Fatalf("the shell showed %q", shown)
	}
}

// A save that fails after its project closed lost the work of the person, so the failure is shown.
func TestASaveThatFailsAfterItsProjectClosedIsShown(t *testing.T) {
	f := modifiedShell(t)
	f.host.failForwards = errors.New("the disk is full")
	saveOutlivesItsProject(t, f, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	var shown []string
	for deadline := time.Now().Add(5 * time.Second); len(shown) == 0 && time.Now().Before(deadline); {
		f.pending.drain(t)
		shown = f.shownErrors()
	}
	if len(shown) != 1 || !strings.Contains(shown[0], "저장하지 못했습니다 · notes.save: ") {
		t.Fatalf("the shell showed %q", shown)
	}
}

// No command and no status finds a plane after a close, and each answers without stopping the host. The params name a card
// and a tab of the plane that left, so a command gets past its own reading of them.
func TestNoCommandStopsTheHostAfterItsProjectClosed(t *testing.T) {
	probe, _, _ := splitShell(t)
	commands, statuses := probe.shell.Registry().Names()
	stop := func(run func()) (stopped string) {
		defer func() {
			if failure := recover(); failure != nil {
				stopped = fmt.Sprintf("%v at %s", failure, firstShellFrame(string(debug.Stack())))
			}
		}()
		run()
		return ""
	}
	unread := 0
	for _, name := range commands {
		f, left, right := splitShell(t)
		tab := f.tabsOf(right)[0].(map[string]any)["id"]
		raw, err := json.Marshal(map[string]any{"card": left, "tab": tab, "id": left, "side": "left", "zone": "center",
			"plugin": "textprobe", "name": "x", "axis": "width", "size": 10, "title": "x", "from": left, "to": right})
		if err != nil {
			t.Fatal(err)
		}
		closeWithoutAFrame(f)
		stopped := stop(func() {
			f.shell.Registry().RunLater(name, raw, func(_ any, err error) {
				if err != nil && strings.Contains(err.Error(), "json: cannot unmarshal") {
					unread++
					t.Logf("%s did not read the params: %v", name, err)
				}
			})
			f.pending.drain(t)
		})
		if stopped != "" {
			t.Errorf("%s stopped the host: %s", name, stopped)
		}
		f.shownErrors()
	}
	f, _, _ := splitShell(t)
	closeWithoutAFrame(f)
	for _, name := range statuses {
		if stopped := stop(func() { _, _ = f.shell.Registry().Read(name) }); stopped != "" {
			t.Errorf("the status %s stopped the host: %s", name, stopped)
		}
	}
	t.Logf("%d commands, %d statuses, %d did not read the params", len(commands), len(statuses), unread)
}

// firstShellFrame returns the first frame of the shell in a stack.
func firstShellFrame(stack string) string {
	lines := strings.Split(stack, "\n")
	for i, line := range lines {
		if strings.Contains(line, "workbench-mygo/src.") && i+1 < len(lines) {
			return strings.TrimSpace(line) + " " + strings.TrimSpace(lines[i+1])
		}
	}
	return stack
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
