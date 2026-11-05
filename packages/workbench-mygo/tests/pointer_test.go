package workbench_test

import (
	"encoding/json"
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// pointerView draws under a named column the button save when it is present, the button next to it, and an empty place with neither.
type pointerView struct {
	sequence *workbench.PointerSequence
	present  bool
	clicked  int
}

func (v *pointerView) button(c *ui.Context, name, label string) {
	if ui.Button(c.Key(workbench.Exposed{Name: name}), label).Size(100, 40).Clicked() {
		v.clicked++
	}
}

func (v *pointerView) view(c *ui.Context) {
	v.sequence.Watch(ui.Column(c).Size(200, 200)).Children(func() {
		ui.Column(c.Key(workbench.Exposed{Name: "core.list"})).Role(ui.RoleGroup).Label("list").Size(200, 100).Children(func() {
			if v.present {
				v.button(c, "core.save", "Save")
			}
			v.button(c, "core.next", "Next")
		})
		ui.Box(c).Role(ui.RoleGroup).Label("rest").Size(200, 50)
		ui.Box(c).Size(200, 50)
	})
}

// testerElements reads the element tree of a tester.
type testerElements struct{ tester *ui.Tester }

func (e *testerElements) ElementTree() ([]ui.ElementNode, error) { return e.tester.ElementTree(), nil }

func (e *testerElements) ActElement(uint64, ui.Actions, string) error { return nil }

func pointerShown(t *testing.T) (*pointerView, *ui.Tester, *int) {
	t.Helper()
	changes := 0
	elements := &testerElements{}
	view := &pointerView{sequence: workbench.NewPointerSequence(elements, func() { changes++ }, func(err error) { t.Error(err) }), present: true}
	elements.tester = ui.NewTester(view.view, 200, 200)
	elements.tester.Frame()
	return view, elements.tester, &changes
}

func pointerStatus(t *testing.T, sequence *workbench.PointerSequence) string {
	t.Helper()
	text, err := json.Marshal(sequence.Status())
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func wantPointer(t *testing.T, sequence *workbench.PointerSequence, want string) {
	t.Helper()
	if got := pointerStatus(t, sequence); got != want {
		t.Fatalf("the status is %s, want %s", got, want)
	}
}

// What stands behind a dialog is not under the pointer, also where nothing of the dialog is an element.
func TestPointerSequenceDoesNotNameAnElementBehindADialog(t *testing.T) {
	changes := 0
	elements := &testerElements{}
	sequence := workbench.NewPointerSequence(elements, func() { changes++ }, func(err error) { t.Error(err) })
	elements.tester = ui.NewTester(func(c *ui.Context) {
		ui.Button(c.Key(workbench.Exposed{Name: "core.save"}), "Save").Size(200, 200)
		ui.Overlay(c, func() {
			sequence.Watch(ui.Box(c).Absolute().Left(0).Top(0).Right(0).Bottom(0).Modal())
		})
	}, 200, 200)
	elements.tester.Frame()
	elements.tester.Frame()
	elements.tester.Press(50, 50)
	elements.tester.Release(50, 50)
	elements.tester.Frame()
	wantPointer(t, sequence, `{"sequence":1,"down":"unknown","up":"unknown","pressedConnected":null,"click":"unknown"}`)
}

// A press and its release on one element report the element three times, and the next press starts anew.
func TestPointerSequenceReportsAPressAndItsClick(t *testing.T) {
	view, tester, changes := pointerShown(t)
	wantPointer(t, view.sequence, `{"sequence":0,"down":null,"up":null,"pressedConnected":null,"click":null}`)
	if err := tester.Click("Save"); err != nil {
		t.Fatal(err)
	}
	tester.Frame()
	wantPointer(t, view.sequence, `{"sequence":1,"down":"core.save","up":"core.save","pressedConnected":true,"click":"core.save"}`)
	if view.clicked != 1 {
		t.Fatalf("the button ran %d times", view.clicked)
	}
	if *changes != 3 {
		t.Fatalf("the sequence reported %d changes, want one for the press, one for the release and one for the click", *changes)
	}

	box, ok := tester.Find("Next")
	if !ok {
		t.Fatal("no Next button")
	}
	tester.Press(box.X+box.W/2, box.Y+box.H/2)
	wantPointer(t, view.sequence, `{"sequence":2,"down":"core.next","up":null,"pressedConnected":null,"click":null}`)
}

// An element replaced between the press and the release gets no click, the status tells that it left the workbench, and the
// release names what stands there now.
func TestPointerSequenceReportsALostClick(t *testing.T) {
	view, tester, _ := pointerShown(t)
	box, ok := tester.Find("Save")
	if !ok {
		t.Fatal("no Save button")
	}
	x, y := box.X+box.W/2, box.Y+box.H/2
	tester.Press(x, y)
	view.present = false
	tester.Frame()
	tester.Release(x, y)
	tester.Frame()
	wantPointer(t, view.sequence, `{"sequence":1,"down":"core.save","up":"core.next","pressedConnected":false,"click":null}`)
	if view.clicked != 0 {
		t.Fatalf("the replaced button ran %d times", view.clicked)
	}
}

// A release away from the pressed element clicks the nearest element around both, as a page does, and runs no button.
func TestPointerSequenceClicksAroundAReleaseAway(t *testing.T) {
	view, tester, _ := pointerShown(t)
	save, _ := tester.Find("Save")
	next, _ := tester.Find("Next")
	tester.Press(save.X+save.W/2, save.Y+save.H/2)
	tester.Move(next.X+next.W/2, next.Y+next.H/2)
	tester.Release(next.X+next.W/2, next.Y+next.H/2)
	tester.Frame()
	wantPointer(t, view.sequence, `{"sequence":1,"down":"core.save","up":"core.next","pressedConnected":true,"click":"core.list"}`)
	if view.clicked != 0 {
		t.Fatalf("a button ran %d times", view.clicked)
	}
}

// An element without a name reports the role of what stands there, the host's tag: an element around it with a name wins.
func TestPointerSequenceNamesAnElementWithoutAName(t *testing.T) {
	view, tester, _ := pointerShown(t)
	tester.ClickAt(100, 125)
	tester.Frame()
	wantPointer(t, view.sequence, `{"sequence":1,"down":"group","up":"group","pressedConnected":true,"click":"group"}`)
	tester.ClickAt(190, 20)
	tester.Frame()
	wantPointer(t, view.sequence, `{"sequence":2,"down":"core.list","up":"core.list","pressedConnected":true,"click":"core.list"}`)
}

// A press that no element of the tree stands under still counts: a page has its document there.
func TestPointerSequenceNamesAPressOutsideTheTree(t *testing.T) {
	view, tester, _ := pointerShown(t)
	tester.ClickAt(100, 175)
	tester.Frame()
	wantPointer(t, view.sequence, `{"sequence":1,"down":"unknown","up":"unknown","pressedConnected":null,"click":"unknown"}`)
}

// The right button counts as a press and a release and clicks nothing.
func TestPointerSequenceClicksWithThePrimaryButton(t *testing.T) {
	view, tester, _ := pointerShown(t)
	tester.PressButton(1, 100, 125)
	tester.ReleaseButton(1, 100, 125)
	tester.Frame()
	wantPointer(t, view.sequence, `{"sequence":1,"down":"group","up":"group","pressedConnected":true,"click":null}`)
}

// The shell reports a press on a field, which takes its own input, and a press on its empty places.
func TestAPressReportsThePointerSequence(t *testing.T) {
	f := openedShell(t)
	read := func() (down, up, click string, sequence int) {
		got := status[struct {
			Sequence        int
			Down, Up, Click *string
		}](t, f, "core.pointer")
		if got.Down == nil || got.Up == nil || got.Click == nil {
			t.Fatalf("the sequence is %+v", got)
		}
		return *got.Down, *got.Up, *got.Click, got.Sequence
	}
	f.click("core.space-tab.add", "")
	if down, up, click, sequence := read(); sequence != 1 || down != "core.space-tab.add" || up != down || click != down {
		t.Fatalf("the press of a button is %s %s %s %d", down, up, click, sequence)
	}
	f.run("core.rename.begin", map[string]string{"kind": "project", "id": f.host.projects[0]["id"].(string)})
	f.settle()
	f.click("core.rename.input", "")
	if down, up, click, sequence := read(); sequence != 2 || down != "core.rename.input" || up != down || click != down {
		t.Fatalf("the press of the field is %s %s %s %d", down, up, click, sequence)
	}
	bar := f.box("core.chrome.bar", "")
	f.tester.ClickAt(bar.X+bar.W/2, bar.Y+bar.H/2)
	f.settle()
	if down, _, _, sequence := read(); sequence != 3 || down != "core.chrome.bar" {
		t.Fatalf("the press of the bar is %s %d", down, sequence)
	}
}

// A key that presses a button is a click without a press, as in a page, and a pointer press of the button reports one click.
func TestAKeyReportsTheClickOfAButton(t *testing.T) {
	f := openedShell(t)
	f.run("core.focus.set", map[string]any{"name": "core.space-tab.add"})
	f.settle()
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	got := status[workbench.PointerStatus](t, f, "core.pointer")
	if got.Sequence != 0 || got.Down != nil || got.Click == nil || *got.Click != "core.space-tab.add" {
		t.Fatalf("the sequence is %+v", got)
	}
}

// A press in an overlay of the workbench is a press of the workbench: the dialogs and the picker stand outside its root.
func TestAPressInAnOverlayReportsThePointerSequence(t *testing.T) {
	for _, each := range []struct{ title, command, name string }{
		{"settings", "core.settings.open", "core.settings-modal.close"},
		{"debug", "core.debug.open", "core.debug.close"},
	} {
		t.Run(each.title, func(t *testing.T) {
			f := openedShell(t)
			f.settle()
			f.run(each.command, map[string]any{})
			f.settle()
			wantPress(t, f, each.name, "")
		})
	}
}

func wantPress(t *testing.T, f *shellFixture, name, item string) {
	t.Helper()
	before := status[workbench.PointerStatus](t, f, "core.pointer").Sequence
	f.click(name, item)
	got := status[workbench.PointerStatus](t, f, "core.pointer")
	if got.Sequence != before+1 || got.Down == nil || *got.Down != name {
		t.Fatalf("the sequence is %+v", got)
	}
}

func TestAPressInThePickerReportsThePointerSequence(t *testing.T) {
	f := projectWithPlugins(t)
	f.click("core.card.add", f.tabbedCards()[0])
	wantPress(t, f, "core.picker.item", "acme")
}
