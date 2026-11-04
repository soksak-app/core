package workbench_test

import (
	"math"
	"reflect"
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

var sidebarMetrics = workbench.SidebarMetrics{HeadH: 32, FootH: 22, SectionMinH: 32, SectionDivider: 6, SectionHeadGap: 6, SectionHeadPad: 10, SectionHeadText: 11.5}

func pixels(v int) *int { return &v }

func listFrame() workbench.SidebarFrame {
	return workbench.SidebarFrame{
		Sidebar: "left", Space: "spc-1", Layout: "list", Orientation: "vertical", Side: "left",
		Status: "왼쪽 창 사이드바",
		Sections: []workbench.SidebarSection{
			{ID: "files.tree", Name: "Files", Plugin: "files", Height: 100},
			{ID: "git.log", Name: "Log", Plugin: "git", Fill: true},
		},
	}
}

func drawSidebar(frame *workbench.SidebarFrame, run workbench.RunCommand) *ui.Tester {
	var drag workbench.SectionDrag
	return ui.NewTester(func(c *ui.Context) {
		workbench.DrawSidebar(c, workbench.NewElementNames(), &drag, *frame, sidebarMetrics, 240, 400, run, func(*ui.Context, workbench.SidebarSeat) {})
	}, 240, 400)
}

func TestTheHeightsOfTheSectionsOfAList(t *testing.T) {
	section := func(s workbench.SidebarSection) workbench.SidebarSection { return s }
	cases := []struct {
		name     string
		sections []workbench.SidebarSection
		room     float32
		want     []float32
	}{
		{"an integer height is the height of the open section", []workbench.SidebarSection{{ID: "a", Height: 100}}, 400, []float32{100}},
		{"fill sections share the height that the others leave", []workbench.SidebarSection{{ID: "a", Height: 100}, {ID: "b", Fill: true}, {ID: "c", Fill: true}}, 400, []float32{100, 102, 102}},
		{"a folded fill section gives its room to the other fill sections", []workbench.SidebarSection{{ID: "a", Fill: true, Folded: true}, {ID: "b", Fill: true}}, 400, []float32{0, 336}},
		{"a stored size replaces the declared height of a fill section", []workbench.SidebarSection{section(workbench.SidebarSection{ID: "a", Fill: true, Size: pixels(50)}), {ID: "b", Fill: true}}, 400, []float32{50, 286}},
		{"an integer height gives way and a fill section keeps its minimum", []workbench.SidebarSection{{ID: "a", Height: 300}, {ID: "b", Fill: true}}, 200, []float32{104, 32}},
		{"an integer section gives way without a fill section", []workbench.SidebarSection{{ID: "a", Height: 100}, {ID: "b", Height: 100}}, 100, []float32{18, 18}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got := workbench.SectionHeights(test.sections, sidebarMetrics, test.room)
			if len(got) != len(test.want) {
				t.Fatalf("heights %v, want %v", got, test.want)
			}
			for i := range got {
				if math.Abs(float64(got[i]-test.want[i])) > 0.01 {
					t.Fatalf("heights %v, want %v", got, test.want)
				}
			}
		})
	}
}

func TestAListSidebarDrawsItsHeadersAndFoldsASection(t *testing.T) {
	var calls []call
	frame := listFrame()
	tt := drawSidebar(&frame, recorder(&calls))
	element(t, tt, "core.sidebar", 0)
	element(t, tt, "core.sidebar.section", 1)
	if name := element(t, tt, "core.sidebar.section.name", 1); name.Label != "Log" {
		t.Fatalf("the name of the second section is %q", name.Label)
	}
	if header := element(t, tt, "core.sidebar.section.header", 1); header.Actions&ui.ActionPress == 0 {
		t.Fatalf("the header takes no press: %+v", header)
	}
	press(t, tt, "core.sidebar.section.header", 1)
	want := []call{{"core.sidebar.section.fold", map[string]any{"sidebar": "left", "section": "git.log"}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestAFoldedSectionKeepsOnlyItsHeader(t *testing.T) {
	seats := map[string]bool{}
	frame := listFrame()
	frame.Sections[0].Folded = true
	tt := ui.NewTester(func(c *ui.Context) {
		workbench.DrawSidebar(c, workbench.NewElementNames(), &workbench.SectionDrag{}, frame, sidebarMetrics, 240, 400, func(string, map[string]any) {},
			func(_ *ui.Context, seat workbench.SidebarSeat) { seats[seat.SurfaceID] = true })
	}, 240, 400)
	element(t, tt, "core.sidebar.section.header", 0)
	if seats["spc-1/left/files.tree"] {
		t.Fatal("a folded section draws its body")
	}
	if !seats["spc-1/left/git.log"] {
		t.Fatalf("the open section draws no body: %v", seats)
	}
	if _, ok := keyed(tt.ElementTree(), workbench.ElementName{Name: "core.sidebar.section.divider", Index: 0}); ok {
		t.Fatal("a divider lies next to a folded section")
	}
}

func TestTheSeatsOfASidebarNameEverySectionWithItsVisibility(t *testing.T) {
	frame := listFrame()
	frame.Sections[0].Folded = true
	want := []workbench.SidebarSeat{
		{SurfaceID: "spc-1/left/files.tree", Section: "files.tree", Plugin: "files", Title: "Files", Visible: false},
		{SurfaceID: "spc-1/left/git.log", Section: "git.log", Plugin: "git", Title: "Log", Visible: true},
	}
	if got := workbench.SidebarSeats(frame); !slices.Equal(got, want) {
		t.Fatalf("seats %+v, want %+v", got, want)
	}
	frame.Layout, frame.Tab = "tabs", "git.log"
	frame.Sections[0].Folded = false
	if got := workbench.SidebarSeats(frame); got[0].Visible || !got[1].Visible {
		t.Fatalf("a tabs set shows only the selected section: %+v", got)
	}
}

func TestATabsSidebarShowsTheSelectedSection(t *testing.T) {
	var calls []call
	var bodies []string
	frame := listFrame()
	frame.Layout, frame.Tab = "tabs", "files.tree"
	tt := ui.NewTester(func(c *ui.Context) {
		bodies = bodies[:0]
		workbench.DrawSidebar(c, workbench.NewElementNames(), &workbench.SectionDrag{}, frame, sidebarMetrics, 240, 400, recorder(&calls),
			func(_ *ui.Context, seat workbench.SidebarSeat) { bodies = append(bodies, seat.Section) })
	}, 240, 400)
	element(t, tt, "core.sidebar.tabs", 0)
	if !slices.Equal(bodies, []string{"files.tree"}) {
		t.Fatalf("drawn bodies %q", bodies)
	}
	press(t, tt, "core.sidebar.section.tab", 1)
	want := []call{{"core.sidebar.section.select", map[string]any{"sidebar": "left", "section": "git.log"}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestDraggingADividerSizesTheSectionBelowItWithAnIntegerHeight(t *testing.T) {
	var calls []call
	frame := workbench.SidebarFrame{
		Sidebar: "left", Space: "spc-1", Layout: "list", Orientation: "vertical", Side: "left", Status: "s",
		Sections: []workbench.SidebarSection{
			{ID: "a", Name: "A", Plugin: "p", Height: 100},
			{ID: "b", Name: "B", Plugin: "p", Height: 100},
		},
	}
	tt := drawSidebar(&frame, recorder(&calls))
	divider := element(t, tt, "core.sidebar.section.divider", 0)
	x, y := divider.Bounds.X+divider.Bounds.W/2, divider.Bounds.Y+divider.Bounds.H/2
	tt.Press(x, y)
	tt.Move(x, y-20)
	tt.Frame()
	tt.Move(x, y-400)
	tt.Frame()
	tt.Release(x, y-400)
	want := []call{
		{"core.sidebar.section.size", map[string]any{"sidebar": "left", "section": "b", "height": 120}},
		{"core.sidebar.section.size", map[string]any{"sidebar": "left", "section": "b", "height": 168}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestAWindowSidebarEndsInItsStatusLineAndFoldControl(t *testing.T) {
	var calls []call
	frame := listFrame()
	tt := drawSidebar(&frame, recorder(&calls))
	if status := element(t, tt, "core.sidebar.status", 0); status.Label != "왼쪽 창 사이드바" {
		t.Fatalf("the status line says %q", status.Label)
	}
	press(t, tt, "core.sidebar.fold", 0)
	want := []call{{"core.settings.set", map[string]any{"patch": map[string]any{"left": false}}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestACardSidebarEndsInItsOwnStatusLine(t *testing.T) {
	frame := listFrame()
	frame.Sidebar, frame.Side, frame.Status = "card-1:left", "", "왼쪽 사이드바 · Files"
	tt := drawSidebar(&frame, func(string, map[string]any) {})
	if status := element(t, tt, "core.card.sidebar.status", 0); status.Label != "왼쪽 사이드바 · Files" {
		t.Fatalf("the status line says %q", status.Label)
	}
	if _, ok := keyed(tt.ElementTree(), workbench.ElementName{Name: "core.sidebar.fold", Index: 0}); ok {
		t.Fatal("a card sidebar has the fold control of a window sidebar")
	}
}

func TestTheNamesOfASecondSidebarContinueTheOrderOfTheDocument(t *testing.T) {
	first, second := listFrame(), listFrame()
	second.Sidebar, second.Side = "right", "right"
	tt := ui.NewTester(func(c *ui.Context) {
		names := workbench.NewElementNames()
		ui.Row(c).Children(func() {
			for _, frame := range []*workbench.SidebarFrame{&first, &second} {
				workbench.DrawSidebar(c, names, &workbench.SectionDrag{}, *frame, sidebarMetrics, 240, 400, func(string, map[string]any) {}, func(*ui.Context, workbench.SidebarSeat) {})
			}
		})
	}, 480, 400)
	element(t, tt, "core.sidebar", 1)
	element(t, tt, "core.sidebar.section", 3)
	element(t, tt, "core.sidebar.fold", 1)
}

func TestTheSeatOfASectionIsItsBody(t *testing.T) {
	frame := listFrame()
	tt := drawSidebar(&frame, func(string, map[string]any) {})
	seat := func(id string) ui.ElementNode {
		t.Helper()
		var find func(nodes []ui.ElementNode) (ui.ElementNode, bool)
		find = func(nodes []ui.ElementNode) (ui.ElementNode, bool) {
			for _, node := range nodes {
				if node.Key == id {
					return node, true
				}
				if found, ok := find(node.Children); ok {
					return found, true
				}
			}
			return ui.ElementNode{}, false
		}
		node, ok := find(tt.ElementTree())
		if !ok {
			t.Fatalf("no seat %s", id)
		}
		return node
	}
	first, second := seat("spc-1/left/files.tree").Bounds, seat("spc-1/left/git.log").Bounds
	if first.Y != 32 || first.H != 100 || first.W != 240 {
		t.Fatalf("the seat of the first section is %+v", first)
	}
	if second.Y != 164 || second.H != 214 {
		t.Fatalf("the seat of the fill section is %+v", second)
	}
}
