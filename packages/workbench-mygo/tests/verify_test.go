package workbench_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

func number64(v float64) *float64 { return &v }

// threeCards is a plane of 1000×600 with a gap of 12: a over b at the left, c at the right.
func threeCards(t *testing.T) *layout.Grid {
	t.Helper()
	var state layout.State
	text := `{"xs":[0,0.5,1],"ys":[0,0.5,1],"cards":[
		{"id":"a","c0":0,"c1":1,"r0":0,"r1":1,"data":{}},
		{"id":"b","c0":0,"c1":1,"r0":1,"r1":2,"data":{}},
		{"id":"c","c0":1,"c1":2,"r0":0,"r1":2,"data":{}}]}`
	if err := json.Unmarshal([]byte(text), &state); err != nil {
		t.Fatal(err)
	}
	grid, err := layout.New(&state, layout.Options{Gap: number64(12), Width: number64(1000), Height: number64(600), MinSize: number64(10)})
	if err != nil {
		t.Fatal(err)
	}
	return grid
}

// healthy is the input of a plane that a workbench drew correctly: its cards where the grid has them, with a surface in card c.
func healthy(t *testing.T) workbench.VerifyInput {
	t.Helper()
	grid := threeCards(t)
	rects := grid.Rects()
	surface := workbench.VerifySurface{ID: "tab-1", Declared: layout.Rect{X: 506, Y: 40, W: 494, H: 500}, Applied: layout.Rect{X: 506, Y: 40, W: 494, H: 500}, Visible: true}
	record := &workbench.VerifyRecord{Seq: 3, Surfaces: []workbench.VerifySurface{surface}, Settled: true}
	return workbench.VerifyInput{
		Grid:       grid,
		Tabs:       func(string) int { return 1 },
		Scale:      2,
		CardRadius: 8,
		Latest:     record,
		Seated:     record,
		Drawn:      map[string]workbench.DrawnSurface{"tab-1": {Frame: surface.Declared, Card: "c"}},
		Cards:      rects,
		Plane:      layout.Rect{W: 1000, H: 600},
		Pad:        6,
		Rules:      []layout.Rect{{X: 499.5, Y: -6, W: 1, H: 612}},
		Band:       workbench.DropBand{HeaderPx: 37, FooterPx: 29},
		Head:       36,
		Foot:       28,
		Chrome:     []workbench.CardChrome{{Box: layout.Rect{Y: 0, H: 294}, Head: layout.Rect{Y: 1, H: 36}, Foot: layout.Rect{Y: 265, H: 28}}},
	}
}

func row(t *testing.T, rows []workbench.VerifyRow, prefix string) workbench.VerifyRow {
	t.Helper()
	for _, candidate := range rows {
		if strings.HasPrefix(candidate.Name, prefix) {
			return candidate
		}
	}
	t.Fatalf("no row %s in %+v", prefix, rows)
	return workbench.VerifyRow{}
}

// A plane drawn as the grid has it passes every row, and the rows are those of the page workbench.
func TestVerifyPassesADrawnPlane(t *testing.T) {
	rows, err := workbench.Verify(healthy(t))
	if err != nil {
		t.Fatal(err)
	}
	var names, skipped []string
	for _, candidate := range rows {
		name := strings.Fields(candidate.Name)[0]
		switch {
		case candidate.Skipped:
			skipped = append(skipped, name)
		case !candidate.OK:
			t.Errorf("row %s failed: %s", candidate.Name, candidate.Note)
			fallthrough
		default:
			names = append(names, name)
		}
	}
	want := "V1 V2 V3 V4 V5 V6 V7a V7b V10 R D T5"
	if got := strings.Join(names, " "); got != want {
		t.Fatalf("the rows are %s, want %s", got, want)
	}
	// V7c and V8 have nothing to measure in a native window, V0 and V9 need a rail, P a window sidebar and W the window buttons.
	if got, want := strings.Join(skipped, " "), "V0 V7c V8 V9 P W"; got != want {
		t.Fatalf("the skipped checks are %s, want %s", got, want)
	}
}

// Each row fails on the state that it exists to find, and only a named row of the case fails.
func TestVerifyRowsFindTheirDefects(t *testing.T) {
	for _, c := range []struct {
		name   string
		row    string
		change func(in *workbench.VerifyInput)
	}{
		{"a drawn surface away from its commit", "V7a", func(in *workbench.VerifyInput) {
			drawn := in.Drawn["tab-1"]
			drawn.Frame.X += 1
			in.Drawn["tab-1"] = drawn
		}},
		{"a surface missing from the commit", "V7a", func(in *workbench.VerifyInput) {
			in.Drawn["tab-2"] = workbench.DrawnSurface{}
		}},
		{"a surface that left the plane", "V7a", func(in *workbench.VerifyInput) { delete(in.Drawn, "tab-1") }},
		{"a blur that differs", "V7a", func(in *workbench.VerifyInput) {
			drawn := in.Drawn["tab-1"]
			drawn.Dim = true
			in.Drawn["tab-1"] = drawn
		}},
		{"a surface applied outside its declaration", "V7b", func(in *workbench.VerifyInput) {
			surface := in.Latest.Surfaces[0]
			surface.Applied.W += 1
			in.Seated = &workbench.VerifyRecord{Seq: 3, Surfaces: []workbench.VerifySurface{surface}}
		}},
		{"a rail stroke through a card", "V9", func(in *workbench.VerifyInput) {
			in.Outline.Loops = [][]layout.Point{{{X: 100, Y: 100}, {X: 200, Y: 100}, {X: 200, Y: 200}, {X: 100, Y: 200}}}
			in.RailGroups = [][]layout.Rect{{{X: 100, Y: 100, W: 100, H: 100}}}
			in.Outline.Corners, in.Outline.Sharp = 4, 0
		}},
		{"a rail without its loop", "V0", func(in *workbench.VerifyInput) {
			in.RailGroups = [][]layout.Rect{{{X: 100, Y: 100, W: 100, H: 100}}}
		}},
		{"a surface that leaves its card", "V10", func(in *workbench.VerifyInput) {
			surface := in.Latest.Surfaces[0]
			surface.Applied.Y = -5
			in.Latest = &workbench.VerifyRecord{Seq: 3, Surfaces: []workbench.VerifySurface{surface}}
		}},
		{"a rule past the margin", "R", func(in *workbench.VerifyInput) { in.Rules[0].Y = -7 }},
		{"a drop band that ends before the drawn head", "D", func(in *workbench.VerifyInput) { in.Band.HeaderPx = 36 }},
		{"a card without a tab", "T5", func(in *workbench.VerifyInput) { in.Tabs = func(string) int { return 0 } }},
	} {
		t.Run(c.name, func(t *testing.T) {
			in := healthy(t)
			c.change(&in)
			rows, err := workbench.Verify(in)
			if err != nil {
				t.Fatal(err)
			}
			if failed := row(t, rows, c.row); failed.OK || failed.Skipped {
				t.Fatalf("row %s did not fail: %+v", failed.Name, failed)
			}
		})
	}
}

// While the host has not answered a commit, the rows that compare with it are skipped and are no pass.
func TestVerifyWaitsForAPendingPlacement(t *testing.T) {
	in := healthy(t)
	in.Pending = true
	drawn := in.Drawn["tab-1"]
	drawn.Frame.X += 10
	in.Drawn["tab-1"] = drawn
	in.Rules[0].Y = -50
	rows, err := workbench.Verify(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, prefix := range []string{"V7a", "V10", "R"} {
		if got := row(t, rows, prefix); !got.Skipped || got.OK {
			t.Fatalf("row %s judged a pending placement: %+v", got.Name, got)
		}
	}
}

// A window sidebar stands at its edge at full height.
func TestVerifyFindsAMisplacedWindowSidebar(t *testing.T) {
	var state layout.State
	text := `{"xs":[0,0.2,1],"ys":[0,1],"cards":[
		{"id":"a","c0":0,"c1":1,"r0":0,"r1":1,"data":{}},
		{"id":"left","c0":1,"c1":2,"r0":0,"r1":1,"fixed":true}]}`
	if err := json.Unmarshal([]byte(text), &state); err != nil {
		t.Fatal(err)
	}
	grid, err := layout.New(&state, layout.Options{Gap: number64(12), Width: number64(1000), Height: number64(600), MinSize: number64(10)})
	if err != nil {
		t.Fatal(err)
	}
	in := healthy(t)
	in.Grid, in.Cards = grid, grid.Rects()
	rows, err := workbench.Verify(in)
	if err != nil {
		t.Fatal(err)
	}
	if got := row(t, rows, "P"); got.OK {
		t.Fatalf("a left sidebar away from the left edge passed: %s", got.Note)
	}
}

// The window buttons are compared only when they stand in the first row.
func TestVerifyComparesTheWindowButtons(t *testing.T) {
	in := healthy(t)
	in.Bar = layout.Rect{Y: 0, H: 40}
	in.Controls = &layout.Rect{Y: 12, H: 16}
	rows, err := workbench.Verify(in)
	if err != nil {
		t.Fatal(err)
	}
	if got := row(t, rows, "W"); !got.OK {
		t.Fatalf("centred buttons failed: %s", got.Note)
	}
	in.Controls = &layout.Rect{Y: 10, H: 16}
	if rows, err = workbench.Verify(in); err != nil {
		t.Fatal(err)
	}
	if got := row(t, rows, "W"); got.OK {
		t.Fatalf("buttons off the centre passed: %s", got.Note)
	}
	in.Controls = &layout.Rect{Y: 60, H: 16}
	if rows, err = workbench.Verify(in); err != nil {
		t.Fatal(err)
	}
	if got := row(t, rows, "W"); !got.Skipped {
		t.Fatalf("buttons out of the row were compared: %+v", got)
	}
}

// A scale that is not positive is an error, not a pass.
func TestVerifyRefusesAScaleThatIsNotPositive(t *testing.T) {
	in := healthy(t)
	in.Scale = 0
	if _, err := workbench.Verify(in); err == nil || err.Error() != "verify: the device pixel ratio 0 is not a positive number" {
		t.Fatalf("the verification failed with %v", err)
	}
}

// core.verify holds null before the first verification and then the rows of the current state: a failed layout is a row of its
// own, and a state without a drawn plane holds no other row.
func TestVerificationStatus(t *testing.T) {
	verification := workbench.NewVerification()
	encoded := func() string {
		text, err := json.Marshal(verification.Status())
		if err != nil {
			t.Fatal(err)
		}
		return string(text)
	}
	if got := encoded(); got != "null" {
		t.Fatalf("the first status is %s", got)
	}
	rows := func() ([]workbench.VerifyRow, error) {
		return []workbench.VerifyRow{{Name: "V1", Note: "a", OK: true}, {Name: "V2", Note: "b", OK: false}, {Name: "V3", Note: "c", Skipped: true}}, nil
	}
	if err := verification.Update(true, rows, nil); err != nil {
		t.Fatal(err)
	}
	if want := `{"failed":1,"rows":[{"name":"V1","note":"a","ok":true},{"name":"V2","note":"b","ok":false}],"skipped":[{"name":"V3","note":"c"}]}`; encoded() != want {
		t.Fatalf("the status is %s, want %s", encoded(), want)
	}
	failure := "the current image raster did not present"
	if err := verification.Update(false, rows, &failure); err != nil {
		t.Fatal(err)
	}
	if want := `{"failed":1,"rows":[{"name":"Surface presentation","note":"the current image raster did not present","ok":false}],"skipped":[]}`; encoded() != want {
		t.Fatalf("the status is %s, want %s", encoded(), want)
	}
	if err := verification.Update(false, rows, nil); err != nil {
		t.Fatal(err)
	}
	if want := `{"failed":0,"rows":[],"skipped":[]}`; encoded() != want {
		t.Fatalf("the status is %s, want %s", encoded(), want)
	}
}

// The rows read the elements that the window drew: a card drawn away from its grid place is a row that fails.
func TestVerifyReadsTheDrawnCards(t *testing.T) {
	grid := threeCards(t)
	offset := float32(0)
	tester := ui.NewTester(func(c *ui.Context) {
		ui.Box(c).Size(1000, 600).Children(func() {
			for _, card := range grid.Cards() {
				rect := grid.Rects()[card.ID]
				ui.Box(c.Key(workbench.Exposed{Name: "core.card", Item: card.ID})).Label(card.ID).Role(ui.RoleGroup).
					Absolute().Left(float32(rect.X)+offset).Top(float32(rect.Y)).Size(float32(rect.W), float32(rect.H))
			}
		})
	}, 1000, 600)
	tester.Frame()
	in := healthy(t)
	in.Cards = workbench.DrawnCards(tester.ElementTree(), layout.Rect{W: 1000, H: 600})
	if len(in.Cards) != 3 {
		t.Fatalf("the tree gave the cards %+v", in.Cards)
	}
	rows, err := workbench.Verify(in)
	if err != nil {
		t.Fatal(err)
	}
	if got := row(t, rows, "V10"); !got.OK {
		t.Fatalf("the drawn plane failed %s: %s", got.Name, got.Note)
	}

	offset = 20
	tester.Frame()
	in.Cards = workbench.DrawnCards(tester.ElementTree(), layout.Rect{W: 1000, H: 600})
	if rows, err = workbench.Verify(in); err != nil {
		t.Fatal(err)
	}
	if got := row(t, rows, "V10"); got.OK {
		t.Fatalf("a surface outside its drawn card passed: %s", got.Note)
	}
}

// A failed row states the measured values with which the cause can be found: the surfaces that it counts, and the surface that is
// off the most inside its card.
func TestVerifyNamesWhatItFound(t *testing.T) {
	in := healthy(t)
	drawn := in.Drawn["tab-1"]
	drawn.Frame.X += 1
	in.Drawn["tab-1"] = drawn
	in.Drawn["tab-2"] = workbench.DrawnSurface{}
	in.Latest.Surfaces = append(in.Latest.Surfaces, workbench.VerifySurface{ID: "tab-3", Visible: true})
	surface := in.Latest.Surfaces[0]
	surface.Applied.W += 1
	in.Seated = &workbench.VerifyRecord{Seq: 3, Surfaces: []workbench.VerifySurface{surface}, Settled: true}
	rows, err := workbench.Verify(in)
	if err != nil {
		t.Fatal(err)
	}
	for id, parts := range map[string][]string{
		"V7a": {"커밋에 없는 표면 1 [tab-2]", "사라진 표면 1 [tab-3]", "seated 3", "pending false", "tab-1 drawn", "· card ", "inset ", "· plane ", "devicePixelRatio 2"},
		"V7b": {"정지", "(seq 3)", "tab-1 declared"},
	} {
		note := row(t, rows, id).Note
		for _, part := range parts {
			if !strings.Contains(note, part) {
				t.Errorf("row %s does not state %q: %s", id, part, note)
			}
		}
	}
	in.Seated.Settled = false
	if rows, err = workbench.Verify(in); err != nil {
		t.Fatal(err)
	}
	if note := row(t, rows, "V7b").Note; !strings.Contains(note, "갱신 중") {
		t.Errorf("row V7b does not state an update in progress: %s", note)
	}
}
