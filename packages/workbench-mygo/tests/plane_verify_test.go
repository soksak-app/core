package workbench_test

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"

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
				// The host fits the declared rectangle inward to the device pixels of the scale 2.
				x, y := surface["x"].(float64), surface["y"].(float64)
				left, top := math.Ceil(x*2)/2, math.Ceil(y*2)/2
				right, bottom := math.Floor((x+surface["w"].(float64))*2)/2, math.Floor((y+surface["h"].(float64))*2)/2
				placements = append(placements, map[string]any{"id": surface["id"], "visible": surface["visible"],
					"x": left + stored.moved, "y": top, "w": right - left, "h": bottom - top})
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
	for _, name := range []string{"V0 ", "V1 ", "V2 ", "V3 ", "V4 ", "V5 ", "V6 ", "V7a ", "V7c ", "V7b ", "V8 ", "V9 ", "V10 ", "R ", "D ", "T5 ", "P ", "W "} {
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
