package workbench_test

import (
	"encoding/json"
	"errors"
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

func TestTheRecordOfADragHoldsTheBoundaryBeforeTheDragAndAfterEachStep(t *testing.T) {
	f, left, right := splitShell(t)
	box, _ := f.divider(left, right)
	x, y := box.X+box.W/2, box.Y+box.H/2
	raw, _ := json.Marshal(map[string]any{"axis": "x", "line": dragLine(t, f, right)})
	reply := func(method string, params json.RawMessage) (any, error) {
		t.Helper()
		var answer any
		var failure error
		answered := false
		f.shell.Registry().Reply(method, params, nil, func(value any, err error) { answer, failure, answered = value, err, true })
		if !answered {
			t.Fatalf("%s did not answer", method)
		}
		return answer, failure
	}
	if _, err := reply("diagnostics.drag", raw); err != nil {
		t.Fatal(err)
	}
	if _, err := reply("diagnostics.drag", raw); err == nil || err.Error() != "another drag of this window is running" {
		t.Fatalf("a second drag answered %v", err)
	}
	// Only a step of a held boundary counts: the move before the press holds no boundary.
	f.tester.Move(x, y)
	f.tester.Frame()
	f.tester.Press(x, y)
	f.tester.Frame()
	for _, step := range []float32{-10, -20, -30, -20, -10, 0} {
		f.tester.Move(x+step, y)
		f.tester.Frame()
	}
	f.tester.Release(x, y)
	f.settle()
	answer, err := reply("diagnostics.drag.end", nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(answer)
	var result struct {
		Boundary []float64 `json:"boundary"`
	}
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Boundary) != 7 {
		t.Fatalf("the record is %s, want 7 positions", encoded)
	}
	for i, want := range []float64{0, -10, -20, -30, -20, -10, 0} {
		if math.Abs(result.Boundary[i]-result.Boundary[0]-want) > 0.5 {
			t.Fatalf("position %d of %v is not the start %v", i, result.Boundary, want)
		}
	}
	// The record ended: a step after its end records nothing, and another end has no drag.
	if _, err := reply("diagnostics.drag.end", nil); err == nil || err.Error() != "no drag of this window is running" {
		t.Fatalf("a second end answered %v", err)
	}
}

// A drag asks the window for its last placement (workbench.placement.last). A placement that runs when the steps arrive holds none of them, so the answer waits for
// the placement that follows it. The frame of those steps opened the layout, which holds the frames of the window, so the answer
// of the running placement places the steps at once.
func TestTheLastPlacementOfADragIsThePlacementAfterTheOneThatRuns(t *testing.T) {
	f, stored := surfaceShell(t)
	left := f.tabbedCards()[0]
	made, err := f.answer("core.card.split", map[string]string{"card": left, "side": "right", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	right := made["card"].(string)
	f.settle()
	box, _ := f.divider(left, right)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.Move(x, y)
	f.tester.Frame()
	f.tester.Press(x, y)
	f.tester.Frame()
	// The press may place too; it ends before the steps arrive.
	f.pending.drain(t)
	began := len(stored.requests)

	// The first step starts a placement, which runs until the queue drains. The next steps and the release wait for it.
	f.tester.Move(x-20, y)
	f.tester.Frame()
	f.tester.Move(x-40, y)
	f.tester.Frame()
	f.tester.Release(x-40, y)
	f.tester.Frame()

	answered := false
	var failure error
	answeredAt := 0
	f.shell.Registry().Reply("workbench.placement.last", nil, nil, func(_ any, err error) {
		answered, failure, answeredAt = true, err, len(stored.requests)
	})
	if answered {
		t.Fatalf("the window answered while a placement ran: %v", failure)
	}
	f.pending.drain(t)
	if !answered || answeredAt != began+2 {
		t.Fatalf("the window answered %t after %d placements, not after the placement that followed the one that ran", answered, answeredAt-began)
	}
	if got := len(stored.requests); got != began+2 {
		t.Fatalf("after the first placement the window sent %d placements", got-began)
	}
	if settled := stored.requests[len(stored.requests)-1]["settled"]; settled != true {
		t.Fatalf("the last placement of the drag has settled %v", settled)
	}
	if !answered || failure != nil {
		t.Fatalf("after the last placement the window answered %t with %v", answered, failure)
	}
}

// A last placement that fails fails the drag, which then does not claim a presented layout. The placement that ran when
// the steps arrived succeeds, so the failure is the one of the last placement.
func TestAFailedLastPlacementAnswersItsFailure(t *testing.T) {
	f, stored := surfaceShell(t)
	left := f.tabbedCards()[0]
	made, err := f.answer("core.card.split", map[string]string{"card": left, "side": "right", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	right := made["card"].(string)
	f.settle()
	box, _ := f.divider(left, right)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.Move(x, y)
	f.tester.Frame()
	f.tester.Press(x, y)
	f.tester.Frame()
	f.pending.drain(t)
	began := len(stored.requests)
	f.tester.Move(x-20, y)
	f.tester.Frame()
	f.tester.Move(x-40, y)
	f.tester.Frame()
	f.tester.Release(x-40, y)
	f.tester.Frame()
	var failure error
	answered := false
	f.shell.Registry().Reply("workbench.placement.last", nil, nil, func(_ any, err error) { answered, failure = true, err })
	// The placement that runs when the steps arrive is the first after the press, and the steps are placed after it.
	stored.presentFailure = errors.New("the current image raster did not present within 10s")
	stored.presentFailureFrom = began + 2
	f.pending.drain(t)
	if !answered || failure == nil || !strings.Contains(failure.Error(), stored.presentFailure.Error()) {
		t.Fatalf("the window answered %t with %v", answered, failure)
	}
}
