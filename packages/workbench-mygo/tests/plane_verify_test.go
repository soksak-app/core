package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
	host "github.com/soksak-app/core/packages/host/go/src"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// placingHost is a host that applies each declared surface, moved by moved, and answers the buttons of the window at the middle
// of the first row.
type placingHost struct {
	surfaceHost
	moved float64
}

func placingShell(t *testing.T) (*shellFixture, *placingHost) {
	t.Helper()
	stored := &placingHost{surfaceHost: surfaceHost{window: workbench.WindowView{Visible: true, Scale: 2, Width: 1200, Height: 800}}}
	stored.calls = map[string]workbench.HostCall{
		"syncSurfaces": func(_ context.Context, argument json.RawMessage) (any, error) {
			var raw struct {
				Surfaces []map[string]any `json:"surfaces"`
			}
			if err := json.Unmarshal(argument, &raw); err != nil {
				return nil, err
			}
			placements := []any{}
			for _, surface := range raw.Surfaces {
				// The element of the frame stands the view on the whole points inside the slot.
				x, y := surface["x"].(float64), surface["y"].(float64)
				left, top := math.Ceil(x), math.Ceil(y)
				right, bottom := math.Floor(x+surface["w"].(float64)), math.Floor(y+surface["h"].(float64))
				placements = append(placements, map[string]any{"id": surface["id"], "visible": surface["visible"],
					"x": left + stored.moved, "y": top, "w": max(right-left, 0), "h": max(bottom-top, 0)})
			}
			return map[string]any{"ticket": 1, "placements": placements,
				"chrome": map[string]any{"controls": map[string]any{"x": 12, "y": 12, "w": 52, "h": 16}, "row": 40}}, nil
		},
		"presentSurfaces": func(_ context.Context, argument json.RawMessage) (any, error) {
			var request struct {
				Placements json.RawMessage `json:"placements"`
			}
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			return request.Placements, nil
		},
	}
	f := surfaceShellOn(t, installedDocument, &stored.surfaceHost)
	return f, stored
}

// resized draws the window at width until the placement that it starts has its answer.
func resized(f *shellFixture, width int) {
	f.t.Helper()
	f.tester.SetSize(width, 800)
	for range 2 {
		f.pending.drain(f.t)
		f.tester.Frame()
	}
	f.pending.drain(f.t)
}

func verifyRow(t *testing.T, status workbench.VerifyStatus, prefix string) workbench.VerifyRow {
	t.Helper()
	for _, row := range status.Rows {
		if strings.HasPrefix(row.Name, prefix) {
			return row
		}
	}
	t.Fatalf("no row %s in %+v", prefix, status.Rows)
	return workbench.VerifyRow{}
}

// A plane that the window drew and the host applied has the rows of the page workbench, and each of them passes.
func TestTheVerificationReadsTheDrawnPlane(t *testing.T) {
	f, _ := placingShell(t)
	resized(f, 1000)
	verify := status[workbench.VerifyStatus](t, f, "core.verify")
	// These measure a plane with one card and one surface. The other checks of the page workbench are listed as skipped.
	for _, name := range []string{"V2 ", "V4 ", "V5 ", "V7a ", "V7b ", "V10 ", "R ", "D ", "T5 ", "W "} {
		verifyRow(t, verify, name)
	}
	if verify.Failed != 0 {
		t.Fatalf("core.verify is %+v", verify)
	}
}

// A surface that the host applied elsewhere than the workbench declared fails the rows that read the answer of the host.
func TestTheVerificationStatesAPlacementThatTheHostMoved(t *testing.T) {
	f, stored := placingShell(t)
	stored.moved = 3
	resized(f, 1000)
	verify := status[workbench.VerifyStatus](t, f, "core.verify")
	if verifyRow(t, verify, "V7b ").OK || verify.Failed == 0 {
		t.Fatalf("core.verify is %+v", verify)
	}
}

// V7a measures the slot that the window drew, and not the box that the workbench computed: a slot elsewhere fails it.
func TestTheVerificationMeasuresTheDrawnSlot(t *testing.T) {
	f, _ := placingShell(t)
	resized(f, 1000)
	if verify := status[workbench.VerifyStatus](t, f, "core.verify"); !verifyRow(t, verify, "V7a ").OK {
		t.Fatalf("core.verify is %+v", verify)
	}
	var moved int
	var move func(nodes []ui.ElementNode)
	move = func(nodes []ui.ElementNode) {
		for index := range nodes {
			if _, ok := nodes[index].Key.(workbench.SurfaceSlot); ok {
				nodes[index].Bounds.X += 5
				moved++
			}
			move(nodes[index].Children)
		}
	}
	f.treeEdit = move
	verify := status[workbench.VerifyStatus](t, f, "core.verify")
	if moved == 0 {
		t.Fatal("the element tree holds no slot of a surface")
	}
	if verifyRow(t, verify, "V7a ").OK || verify.Failed == 0 {
		t.Fatalf("core.verify is %+v", verify)
	}
}

// The slot stands where the frame declared it at any size of the window, also in a card too small for its rows.
func TestTheDrawnSlotFollowsEverySize(t *testing.T) {
	f, stored := placingShell(t)
	for _, size := range [][2]int{{1000, 700}, {700, 300}, {400, 200}, {200, 120}, {120, 80}, {80, 60}, {40, 30}} {
		stored.window.Width, stored.window.Height = float64(size[0]), float64(size[1])
		f.tester.SetSize(size[0], size[1])
		f.settle()
		verify := status[workbench.VerifyStatus](t, f, "core.verify")
		for _, row := range verify.Rows {
			if !row.OK {
				t.Errorf("%v: %s: %s", size, row.Name, row.Note)
			}
		}
	}
}

// A section surface stands where the sidebar drew its body: the box that the sidebar computes is the slot of the window.
func TestTheVerificationMeasuresASectionSlot(t *testing.T) {
	f, _ := surfaceShellOf(t, sidebarsInstalled)
	verify := status[workbench.VerifyStatus](t, f, "core.verify")
	if row := verifyRow(t, verify, "V7a "); !row.OK {
		t.Fatalf("core.verify is %+v", row)
	}
}

// core.surfaces states where the host applied the surface, which is not where the workbench declared it.
func TestTheSurfaceStatusStatesWhatTheHostApplied(t *testing.T) {
	f, stored := placingShell(t)
	stored.moved = 3
	resized(f, 1000)
	surfaces := status[[]struct {
		Declared, Applied *struct{ X, Y, W, H float64 }
	}](t, f, "core.surfaces")
	if len(surfaces) == 0 {
		t.Fatal("core.surfaces holds no surface")
	}
	for _, surface := range surfaces {
		if surface.Applied == nil || surface.Declared == nil || surface.Applied.X-surface.Declared.X < 2.5 {
			t.Fatalf("declared %+v applied %+v", surface.Declared, surface.Applied)
		}
	}
}

// A frame verifies nothing while nobody watches: the verification runs at a read, over the plane that the last frame drew.
func TestAFrameReadsNoElementTree(t *testing.T) {
	f, _ := placingShell(t)
	resized(f, 1000)
	reads := f.treeReads
	for range 3 {
		f.tester.Frame()
		f.pending.drain(t)
	}
	if f.treeReads != reads {
		t.Fatalf("three frames read the element tree %d times", f.treeReads-reads)
	}
	if verify := status[workbench.VerifyStatus](t, f, "core.verify"); len(verify.Rows) == 0 {
		t.Fatalf("core.verify is %+v", verify)
	}
	if f.treeReads == reads {
		t.Fatal("the read did not verify")
	}
}

// A watcher of core.verify receives the result of a frame without reading it.
func TestAWatchOfTheVerificationFollowsTheFrames(t *testing.T) {
	f, stored := placingShell(t)
	var values []workbench.VerifyStatus
	if _, err := f.shell.Registry().Answer("status.watch", json.RawMessage(`{"name":"core.verify"}`), func(_ string, value any) {
		text, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var verify workbench.VerifyStatus
		if err := json.Unmarshal(text, &verify); err != nil {
			t.Fatal(err)
		}
		values = append(values, verify)
	}); err != nil {
		t.Fatal(err)
	}
	stored.moved = 3
	resized(f, 1000)
	for _, value := range values {
		if value.Failed > 0 {
			return
		}
	}
	t.Fatalf("the watcher received %+v", values)
}

// The verification of a settled plane asks for no frame, or each frame would ask for the next.
func TestASettledPlaneAsksForNoFrame(t *testing.T) {
	f, _ := placingShell(t)
	resized(f, 1000)
	f.tester.Frame()
	f.pending.drain(t)
	frames := f.frames
	for range 3 {
		f.tester.Frame()
		f.pending.drain(t)
	}
	if f.frames != frames {
		t.Fatalf("the settled plane asked for %d frames", f.frames-frames)
	}
}

// Without a drawn plane nothing is verified, and a row of the plane that was drawn before does not stay.
func TestTheLibraryHasNoVerificationRows(t *testing.T) {
	f := newShell(t, &storedHost{})
	verify := status[*workbench.VerifyStatus](t, f, "core.verify")
	if verify != nil && len(verify.Rows) != 0 {
		t.Fatalf("core.verify is %+v", verify)
	}
}

// The setting dim reaches the host: a surface outside the focused card is declared dimmed, and a change of the focus places the
// surfaces again.
func TestTheHostDimsTheSurfaceOutsideTheFocus(t *testing.T) {
	f, stored := surfaceShell(t)
	cards := f.tabbedCards()
	if len(cards) < 2 {
		t.Fatalf("the shell has the cards %v", cards)
	}
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"dim": true}})
	f.settle()
	dimmed := func() (dim, bright int) {
		for _, surface := range stored.lastSurfaces(t) {
			if surface["dim"] == true {
				dim++
			} else {
				bright++
			}
		}
		return dim, bright
	}
	if dim, bright := dimmed(); dim != len(cards)-1 || bright != 1 {
		t.Fatalf("the last request dims %d and leaves %d", dim, bright)
	}
	if verify := status[workbench.VerifyStatus](t, f, "core.verify"); !verifyRow(t, verify, "V7a ").OK {
		t.Fatalf("core.verify is %+v", verify)
	}
	before := len(stored.requests)
	f.run("core.card.focus", map[string]string{"card": cards[0]})
	f.settle()
	f.run("core.card.focus", map[string]string{"card": cards[1]})
	f.settle()
	if len(stored.requests) == before {
		t.Fatal("a change of the focus placed no surface")
	}
}

// A verification that could not run does not leave the answer of the verification before it: a check reads a failure and the reason.
func TestAVerificationThatCannotRunIsAFailure(t *testing.T) {
	f, stored := placingShell(t)
	resized(f, 1000)
	if verify := status[workbench.VerifyStatus](t, f, "core.verify"); verify.Failed != 0 || len(verify.Rows) == 0 {
		t.Fatalf("core.verify is %+v", verify)
	}
	stored.window.Scale = 0
	verify := status[workbench.VerifyStatus](t, f, "core.verify")
	if verify.Failed == 0 || !strings.Contains(verifyRow(t, verify, "Verification").Note, "device pixel ratio") {
		t.Fatalf("core.verify is %+v", verify)
	}
	f.pending.drain(t)
	if len(f.lines) == 0 && len(f.host.written("workbench.record.error")) == 0 {
		t.Fatal("the failed verification reported nothing")
	}
}

// The shell answers core.contributions: the contributions of the installed plugins, which the page workbench states too.
func TestTheShellAnswersItsContributions(t *testing.T) {
	f, _ := surfaceShell(t)
	if _, err := f.shell.Registry().Read("core.contributions"); err != nil {
		t.Fatal(err)
	}
}

// A check that has nothing to measure is no pass: it is listed as skipped and counts in no row and in no failure.
func TestACheckWithNothingToMeasureIsSkipped(t *testing.T) {
	f, _ := placingShell(t)
	resized(f, 1000)
	verify := status[workbench.VerifyStatus](t, f, "core.verify")
	for _, name := range []string{"V7c ", "V8 "} {
		for _, row := range verify.Rows {
			if strings.HasPrefix(row.Name, name) {
				t.Fatalf("%s is a row: %+v", name, row)
			}
		}
		found := false
		for _, skipped := range verify.Skipped {
			found = found || strings.HasPrefix(skipped.Name, name) && skipped.Note != ""
		}
		if !found {
			t.Fatalf("%s is not skipped: %+v", name, verify.Skipped)
		}
	}
	if verify.Failed != 0 {
		t.Fatalf("core.verify is %+v", verify)
	}
}

// core.modal states the open modal as the page workbench does, with no document on a host that has no modal web view.
func TestTheModalStatusStatesTheOpenModal(t *testing.T) {
	f := projectWithPlugins(t)
	f.settle()
	if got := f.status("core.modal"); got != "null" {
		t.Fatalf("core.modal is %s with no modal", got)
	}
	f.click("core.card.add", f.tabbedCards()[0])
	if got, want := f.status("core.modal"), `{"id":"picker","mode":"menu","document":null}`; got != want {
		t.Fatalf("core.modal is %s, want %s", got, want)
	}
	f.run("core.picker.close", nil)
	f.settle()
	if got := f.status("core.modal"); got != "null" {
		t.Fatalf("core.modal is %s after the menu closed", got)
	}
	f.run("core.settings.open", nil)
	f.settle()
	if got, want := f.status("core.modal"), `{"id":"settings","mode":"dialog","document":null}`; got != want {
		t.Fatalf("core.modal is %s, want %s", got, want)
	}
}

// core.grid states the sides that a card presents.
func TestTheGridStatesTheSidesOfACard(t *testing.T) {
	f, card := cardSidebar(t, "left")
	f.settle()
	var grid struct {
		Cards []struct {
			ID       string `json:"id"`
			Sidebars map[string]struct {
				Set       *string  `json:"set"`
				Size      float64  `json:"size"`
				Collapsed bool     `json:"collapsed"`
				ShownSize *float64 `json:"shownSize"`
			} `json:"sidebars"`
		} `json:"cards"`
	}
	if err := json.Unmarshal([]byte(f.status("core.grid")), &grid); err != nil {
		t.Fatal(err)
	}
	for _, drawn := range grid.Cards {
		if drawn.ID != card {
			continue
		}
		left, ok := drawn.Sidebars["left"]
		if !ok || left.Set == nil || left.Size <= 0 || left.ShownSize == nil {
			t.Fatalf("the sides of the card are %+v", drawn.Sidebars)
		}
		box := f.box("core.sidebar", card+":left")
		if *left.ShownSize != float64(box.W) {
			t.Fatalf("the side states %v and the window drew %v", *left.ShownSize, box.W)
		}
		return
	}
	t.Fatalf("core.grid has no card %s", card)
}

// shownError reads the error that the workbench shows, or "" when it shows none.
func shownError(t *testing.T, f *shellFixture) string {
	t.Helper()
	shown, err := f.shell.Registry().Read("core.workbench.error")
	if err != nil {
		t.Fatal(err)
	}
	if text, ok := shown.(*string); ok && text != nil {
		return *text
	}
	return ""
}

// A read of the verification reads the window, and the step that gives a watcher the result of a frame can run after the window
// closed. A window that closed has no screen and nothing to verify, so the read shows no failure.
func TestAVerificationOfAClosedWindowShowsNoFailure(t *testing.T) {
	f, stored := placingShell(t)
	resized(f, 1000)
	stored.windowFailure = &host.RPCError{Code: 1003, Message: `window "main" does not exist`}
	status[workbench.VerifyStatus](t, f, "core.verify")
	if text := shownError(t, f); text != "" {
		t.Fatalf("the closed window shows %q", text)
	}
}

// The status that reads the window answers null for a window that closed, and shows no failure.
func TestTheWorkbenchStatusOfAClosedWindowShowsNoFailure(t *testing.T) {
	f, stored := placingShell(t)
	resized(f, 1000)
	stored.windowFailure = &host.RPCError{Code: 1003, Message: `window "main" does not exist`}
	shown, err := f.shell.Registry().Read("core.window.workbench")
	if err != nil {
		t.Fatal(err)
	}
	if shown != nil {
		t.Fatalf("the status of a closed window is %v", shown)
	}
	if text := shownError(t, f); text != "" {
		t.Fatalf("the closed window shows %q", text)
	}
}

// Any other failure to read the window stays a failure that the workbench shows.
func TestAReadOfAnOpenWindowThatFailsIsShown(t *testing.T) {
	for _, name := range []string{"core.verify", "core.window.workbench"} {
		t.Run(name, func(t *testing.T) {
			f, stored := placingShell(t)
			resized(f, 1000)
			stored.windowFailure = errors.New("the window state cannot be read")
			if _, err := f.shell.Registry().Read(name); err != nil {
				t.Fatal(err)
			}
			if text := shownError(t, f); text != "the window state cannot be read" {
				t.Fatalf("the workbench shows %q", text)
			}
		})
	}
}
