package workbench_test

import (
	"encoding/json"
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// pointerView draws the button save when it is present, and the button next to it. Each button reports its press and its click
// to sequence, as the binder does.
type pointerView struct {
	sequence *workbench.PointerSequence
	present  bool
	clicked  int
}

func (v *pointerView) button(c *ui.Context, name, label string) {
	button := ui.Button(c.Key(name), label).Size(100, 40).HandleInput(v.sequence.Handler(name))
	if button.Clicked() {
		v.sequence.Click(name)
		v.clicked++
	}
}

func (v *pointerView) view(c *ui.Context) {
	v.sequence.Frame()
	ui.Column(c).Children(func() {
		if v.present {
			v.button(c, "core.save", "Save")
		}
		v.button(c, "core.next", "Next")
	})
}

func pointerStatus(t *testing.T, sequence *workbench.PointerSequence) string {
	t.Helper()
	text, err := json.Marshal(sequence.Status())
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

// A press and its release on one element report the element three times, and the next press starts anew.
func TestPointerSequenceReportsAPressAndItsClick(t *testing.T) {
	changes := 0
	sequence := workbench.NewPointerSequence(func() { changes++ })
	if want := `{"sequence":0,"down":null,"up":null,"pressedConnected":null,"click":null}`; pointerStatus(t, sequence) != want {
		t.Fatalf("the first status is %s", pointerStatus(t, sequence))
	}
	view := &pointerView{sequence: sequence, present: true}
	tester := ui.NewTester(view.view, 200, 200)
	tester.Frame()
	if err := tester.Click("Save"); err != nil {
		t.Fatal(err)
	}
	tester.Frame()
	want := `{"sequence":1,"down":"core.save","up":"core.save","pressedConnected":true,"click":"core.save"}`
	if got := pointerStatus(t, sequence); got != want {
		t.Fatalf("the status is %s, want %s", got, want)
	}
	if view.clicked != 1 {
		t.Fatalf("the button ran %d times", view.clicked)
	}
	if changes != 3 {
		t.Fatalf("the sequence reported %d changes, want one for the press, one for the release and one for the click", changes)
	}

	box, ok := tester.Find("Next")
	if !ok {
		t.Fatal("no Next button")
	}
	tester.Press(box.X+box.W/2, box.Y+box.H/2)
	want = `{"sequence":2,"down":"core.next","up":null,"pressedConnected":null,"click":null}`
	if got := pointerStatus(t, sequence); got != want {
		t.Fatalf("the status after the second press is %s, want %s", got, want)
	}
}

// An element replaced between the press and the release gets no click, and the status tells that it left the workbench.
func TestPointerSequenceReportsALostClick(t *testing.T) {
	sequence := workbench.NewPointerSequence(func() {})
	view := &pointerView{sequence: sequence, present: true}
	tester := ui.NewTester(view.view, 200, 200)
	tester.Frame()
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
	want := `{"sequence":1,"down":"core.save","up":"core.save","pressedConnected":false,"click":null}`
	if got := pointerStatus(t, sequence); got != want {
		t.Fatalf("the status is %s, want %s", got, want)
	}
	if view.clicked != 0 {
		t.Fatalf("the replaced button ran %d times", view.clicked)
	}
}

// A release away from the pressed element is no click.
func TestPointerSequenceReportsAReleaseAwayFromThePress(t *testing.T) {
	sequence := workbench.NewPointerSequence(func() {})
	view := &pointerView{sequence: sequence, present: true}
	tester := ui.NewTester(view.view, 200, 200)
	tester.Frame()
	box, ok := tester.Find("Save")
	if !ok {
		t.Fatal("no Save button")
	}
	tester.Press(box.X+box.W/2, box.Y+box.H/2)
	tester.Move(190, 190)
	tester.Release(190, 190)
	tester.Frame()
	want := `{"sequence":1,"down":"core.save","up":"core.save","pressedConnected":true,"click":null}`
	if got := pointerStatus(t, sequence); got != want {
		t.Fatalf("the status is %s, want %s", got, want)
	}
}

func TestAPressReportsThePointerSequence(t *testing.T) {
	f := openedShell(t)
	f.click("core.space-tab.add", "")
	got := status[struct {
		Sequence         int
		Down, Up, Click  *string
		PressedConnected *bool
	}](t, f, "core.pointer")
	if got.Sequence != 1 || got.Down == nil || *got.Down != "core.space-tab.add" || got.Up == nil || got.Click == nil || *got.Click != "core.space-tab.add" {
		t.Fatalf("the sequence is %+v", got)
	}
}
