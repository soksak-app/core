package workbench_test

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// dragLine returns the line of the boundary at the left of a card of splitShell, from the grid of the window.
func dragLine(t *testing.T, f *shellFixture, card string) int {
	t.Helper()
	for _, placed := range status[gridRead](t, f, "core.grid").Cards {
		if placed.ID == card {
			return placed.C0
		}
	}
	t.Fatalf("core.grid reports no card %s", card)
	return 0
}

func TestTheDragBoundaryIsTheCentreOfTheGrabArea(t *testing.T) {
	f, left, right := splitShell(t)
	box, _ := f.divider(left, right)
	raw, _ := json.Marshal(map[string]any{"axis": "x", "line": dragLine(t, f, right)})
	var answer any
	f.shell.Registry().Reply("diagnostics.drag.boundary", raw, nil, func(value any, err error) {
		if err != nil {
			t.Fatal(err)
		}
		answer = value
	})
	encoded, _ := json.Marshal(answer)
	var point struct{ X, Y float64 }
	if err := json.Unmarshal(encoded, &point); err != nil {
		t.Fatal(err)
	}
	if math.Abs(point.X-float64(box.X+box.W/2)) > 0.5 || math.Abs(point.Y-float64(box.Y+box.H/2)) > 0.5 {
		t.Fatalf("the point is %+v, the divider is %+v", point, box)
	}
}

func TestADragOfNoBoundaryFailsWithItsLine(t *testing.T) {
	f, _, _ := splitShell(t)
	for _, method := range []string{"diagnostics.drag", "diagnostics.drag.boundary"} {
		raw, _ := json.Marshal(map[string]any{"axis": "x", "line": 99, "ms": 48, "times": 1, "dx": 10})
		var failure error
		f.shell.Registry().Reply(method, raw, nil, func(_ any, err error) { failure = err })
		if failure == nil || !strings.Contains(failure.Error(), "no x boundary at line 99") {
			t.Fatalf("%s answered %v", method, failure)
		}
	}
}

func TestADragStepsTheBoundaryOnTheTicksOfTheHost(t *testing.T) {
	f, left, right := splitShell(t)
	from := f.box("core.card", left)
	stored := cardRowsStored(t, f)
	raw, _ := json.Marshal(map[string]any{"axis": "x", "line": dragLine(t, f, right), "dx": -30, "dy": 0, "ms": 48, "times": 1})
	var answer any
	var failure error
	answered := false
	f.shell.Registry().Reply("diagnostics.drag", raw, nil, func(value any, err error) { answer, failure, answered = value, err, true })
	f.tester.Frame()
	for i := 1; i <= 3; i++ {
		if answered {
			t.Fatalf("the drag answered before tick %d", i)
		}
		f.shell.Event("diagnostics-tick", nil)
		f.tester.Frame()
		want := from.W - float32(10*i)
		if now := f.box("core.card", left); math.Abs(float64(now.W-want)) > 0.5 {
			t.Fatalf("after tick %d the left card is %v wide, want %v", i, now.W, want)
		}
	}
	if stored != cardRowsStored(t, f) {
		t.Fatal("a step of the drag stored the layout before the release")
	}
	for range 3 {
		f.shell.Event("diagnostics-tick", nil)
		f.tester.Frame()
	}
	if !answered || failure != nil {
		t.Fatalf("after the last tick the drag answered %t with %v", answered, failure)
	}
	f.settle()
	if now := f.box("core.card", left); math.Abs(float64(now.W-from.W)) > 0.5 {
		t.Fatalf("the drag ended with the left card %v wide, it was %v", now.W, from.W)
	}
	encoded, _ := json.Marshal(answer)
	var result struct {
		From     struct{ X, Y float64 } `json:"from"`
		Steps    int                    `json:"steps"`
		Asked    int                    `json:"asked"`
		Took     *float64               `json:"took"`
		Late     *int                   `json:"late"`
		Deepest  *int                   `json:"deepest"`
		Boundary []float64              `json:"boundary"`
		Handled  []float64              `json:"handled"`
	}
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	if result.Steps != 6 || result.Asked != 96 || result.Took == nil || result.Late == nil || *result.Late != 0 || result.Deepest == nil ||
		len(result.Boundary) != 7 || len(result.Handled) != 6 || result.From.X == 0 {
		t.Fatalf("the result is %s", encoded)
	}
	if result.Boundary[3]-result.Boundary[0] > -29 || math.Abs(result.Boundary[6]-result.Boundary[0]) > 0.5 {
		t.Fatalf("the boundary moved %v", result.Boundary)
	}
	// A tick without a drag does nothing.
	f.shell.Event("diagnostics-tick", nil)
	f.settle()
	if now := f.box("core.card", left); math.Abs(float64(now.W-from.W)) > 0.5 {
		t.Fatalf("a tick after the drag left the card %v wide", now.W)
	}
}
