package workbench_test

import (
	"image/color"
	"math"
	"reflect"
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

var sidebarMetrics = workbench.SidebarMetrics{HeadH: 32, FootH: 22, SectionMinH: 32, SectionDivider: 6, SectionHeadGap: 6, SectionHeadPad: 10, SectionHeadText: 11.5, SectionTabMark: 2, FoldButton: 18, FoldIcon: 14, SectionHeadMix: 0.03, SectionHeadHoverMix: 0.07}

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

func drawSidebar(frame *workbench.SidebarFrame, binder *workbench.Binder) *ui.Tester {
	var drag workbench.SectionDrag
	return ui.NewTester(func(c *ui.Context) {
		workbench.DrawSidebar(c, binder, &drag, *frame, sidebarMetrics, 240, 400, func(*ui.Context, workbench.SidebarSeat) {})
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
	tt := drawSidebar(&frame, recorder(t, &calls, sidebarCommands...))
	element(t, tt, "core.sidebar", "left")
	element(t, tt, "core.sidebar.section", "left/git.log")
	if name := element(t, tt, "core.sidebar.section.name", "left/git.log"); name.Label != "Log" {
		t.Fatalf("the name of the second section is %q", name.Label)
	}
	if name := element(t, tt, "core.sidebar.section.name", "left/git.log"); name.Bounds.X > sidebarMetrics.SectionHeadPad+2*sidebarMetrics.SectionHeadText {
		t.Fatalf("the header does not start with its chevron and its name: %+v", name.Bounds)
	}
	if header := element(t, tt, "core.sidebar.section.header", "left/git.log"); header.Actions&ui.ActionPress == 0 {
		t.Fatalf("the header takes no press: %+v", header)
	}
	press(t, tt, "core.sidebar.section.header", "left/git.log")
	want := []call{{"core.sidebar.section.fold", map[string]any{"sidebar": "left", "section": "git.log"}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestAFoldedSectionKeepsOnlyItsHeader(t *testing.T) {
	seats := map[string]bool{}
	binder := recorder(t, new([]call), sidebarCommands...)
	frame := listFrame()
	frame.Sections[0].Folded = true
	tt := ui.NewTester(func(c *ui.Context) {
		workbench.DrawSidebar(c, binder, &workbench.SectionDrag{}, frame, sidebarMetrics, 240, 400,
			func(_ *ui.Context, seat workbench.SidebarSeat) { seats[seat.SurfaceID] = seat.Visible })
	}, 240, 400)
	element(t, tt, "core.sidebar.section.header", "left/files.tree")
	if visible, ok := seats["spc-1/left/files.tree"]; !ok || visible {
		t.Fatalf("a folded section keeps its seat without a body: %v", seats)
	}
	if !seats["spc-1/left/git.log"] {
		t.Fatalf("the open section draws no body: %v", seats)
	}
	if _, ok := keyed(tt.ElementTree(), "core.sidebar.section.divider", "left/git.log"); ok {
		t.Fatal("a divider lies next to a folded section")
	}
}

func TestTheSeatsOfASidebarNameEverySectionWithItsVisibility(t *testing.T) {
	frame := listFrame()
	frame.Sections[0].Folded = true
	want := []workbench.SidebarSeat{
		{SurfaceID: "spc-1/left/files.tree", Section: "files.tree", Sidebar: "left", Plugin: "files", Title: "Files", Visible: false},
		{SurfaceID: "spc-1/left/git.log", Section: "git.log", Sidebar: "left", Plugin: "git", Title: "Log", Visible: true},
	}
	if got := workbench.SidebarSeats(frame); !reflect.DeepEqual(got, want) {
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
	binder := recorder(t, &calls, sidebarCommands...)
	tt := ui.NewTester(func(c *ui.Context) {
		bodies = bodies[:0]
		workbench.DrawSidebar(c, binder, &workbench.SectionDrag{}, frame, sidebarMetrics, 240, 400, func(_ *ui.Context, seat workbench.SidebarSeat) {
			if seat.Visible {
				bodies = append(bodies, seat.Section)
			}
		})
	}, 240, 400)
	element(t, tt, "core.sidebar.tabs", "left")
	if !slices.Equal(bodies, []string{"files.tree"}) {
		t.Fatalf("drawn bodies %q", bodies)
	}
	press(t, tt, "core.sidebar.section.tab", "left/git.log")
	want := []call{{"core.sidebar.section.select", map[string]any{"sidebar": "left", "section": "git.log"}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

// A section with an integer height leaves room in a tabs set, and the status line stays at the bottom of the sidebar.
func TestTheStatusLineOfATabsSidebarEndsTheSidebar(t *testing.T) {
	var calls []call
	frame := listFrame()
	frame.Layout, frame.Tab = "tabs", "files.tree"
	tt := drawSidebar(&frame, recorder(t, &calls, sidebarCommands...))
	status := element(t, tt, "core.sidebar.status", "left")
	if bottom := status.Bounds.Y + status.Bounds.H; bottom != 400 {
		t.Fatalf("the status line ends at %v of 400", bottom)
	}
}

// The selected tab differs in its text and its rail mark, and keeps the background of the sidebar.
func TestTheSelectedTabHasTheRailMarkOnItsPlainBackground(t *testing.T) {
	var calls []call
	frame := listFrame()
	frame.Layout, frame.Tab, frame.Rail = "tabs", "files.tree", ui.Hex("#7279ff")
	tt := drawSidebar(&frame, recorder(t, &calls, sidebarCommands...))
	tab := element(t, tt, "core.sidebar.section.tab", "left/files.tree").Bounds
	image := tt.Image()
	rgb := func(x, y float32) [3]uint32 {
		r, g, b, _ := image.At(int(x), int(y)).RGBA()
		return [3]uint32{r >> 8, g >> 8, b >> 8}
	}
	if got, want := rgb(tab.X+2, tab.Y+tab.H-1), [3]uint32{0x72, 0x79, 0xff}; got != want {
		t.Fatalf("the mark is %x, want %x", got, want)
	}
	if got, want := rgb(tab.X+2, tab.Y+2), rgb(tab.X+tab.W+2, tab.Y+2); got != want {
		t.Fatalf("the selected tab has the background %x beside %x", got, want)
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
	tt := drawSidebar(&frame, recorder(t, &calls, sidebarCommands...))
	divider := element(t, tt, "core.sidebar.section.divider", "left/b")
	x, y := divider.Bounds.X+divider.Bounds.W/2, divider.Bounds.Y+divider.Bounds.H/2
	tt.Press(x, y)
	tt.Move(x, y-20)
	tt.Frame()
	tt.Move(x, y-400)
	tt.Frame()
	tt.Release(x, y-400)
	want := []call{
		{"core.sidebar.section.size", map[string]any{"sidebar": "left", "section": "b", "height": 120.0}},
		{"core.sidebar.section.size", map[string]any{"sidebar": "left", "section": "b", "height": 168.0}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestAWindowSidebarEndsInItsStatusLineAndFoldControl(t *testing.T) {
	var calls []call
	frame := listFrame()
	tt := drawSidebar(&frame, recorder(t, &calls, sidebarCommands...))
	if status := element(t, tt, "core.sidebar.status", "left"); status.Label != "왼쪽 창 사이드바" {
		t.Fatalf("the status line says %q", status.Label)
	}
	press(t, tt, "core.sidebar.fold", "left")
	want := []call{{"core.settings.set", map[string]any{"patch": map[string]any{"left": false}}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

// A section shorter than the set leaves the status line at the bottom of the sidebar.
func TestTheStatusLineStandsAtTheBottomOfASidebarWithTabs(t *testing.T) {
	frame := listFrame()
	frame.Layout, frame.Tab = "tabs", frame.Sections[0].ID
	frame.Sections[0].Fill, frame.Sections[0].Height = false, 40
	frame.Sections[0].Size = nil
	tt := drawSidebar(&frame, recorder(t, new([]call), sidebarCommands...))
	status := element(t, tt, "core.sidebar.status", "left")
	if status.Bounds.Y+status.Bounds.H != 400 {
		t.Fatalf("the status line is %+v in a sidebar of the height 400", status.Bounds)
	}
}

func TestACardSidebarEndsInItsOwnStatusLine(t *testing.T) {
	frame := listFrame()
	frame.Sidebar, frame.Side, frame.Status = "card-1:left", "", "왼쪽 사이드바 · Files"
	tt := drawSidebar(&frame, recorder(t, new([]call), sidebarCommands...))
	if status := element(t, tt, "core.card.sidebar.status", "card-1:left"); status.Label != "왼쪽 사이드바 · Files" {
		t.Fatalf("the status line says %q", status.Label)
	}
	if _, ok := keyed(tt.ElementTree(), "core.sidebar.fold", ""); ok {
		t.Fatal("a card sidebar has the fold control of a window sidebar")
	}
}

func TestTheElementsOfTwoSidebarsAreToldApart(t *testing.T) {
	first, second := listFrame(), listFrame()
	second.Sidebar, second.Side = "right", "right"
	binder := recorder(t, new([]call), sidebarCommands...)
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Row(c).Children(func() {
			for _, frame := range []*workbench.SidebarFrame{&first, &second} {
				workbench.DrawSidebar(c, binder, &workbench.SectionDrag{}, *frame, sidebarMetrics, 240, 400, func(*ui.Context, workbench.SidebarSeat) {})
			}
		})
	}, 480, 400)
	element(t, tt, "core.sidebar", "right")
	element(t, tt, "core.sidebar.section", "right/git.log")
	element(t, tt, "core.sidebar.fold", "right")
}

func TestTheSeatOfASectionIsItsBody(t *testing.T) {
	frame := listFrame()
	tt := drawSidebar(&frame, recorder(t, new([]call), sidebarCommands...))
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

// bandColor is the color of a band with share of the text color over body.
func bandColor(body color.RGBA, text ui.Color, share float32) color.RGBA {
	mix := func(from, to uint8) uint8 { return uint8(float32(from)*(1-share) + float32(to)*share + 0.5) }
	return color.RGBA{mix(body.R, text.R), mix(body.G, text.G), mix(body.B, text.B), 255}
}

func near(a, b color.RGBA) bool {
	off := func(x, y uint8) bool { return x+1 < y || y+1 < x }
	return !off(a.R, b.R) && !off(a.G, b.G) && !off(a.B, b.B)
}

// The head of a section and the tab row of a set are a band of the text color over the card, and a pointer over them strengthens it.
func TestASectionHeadIsABandOverTheCard(t *testing.T) {
	for name, layout := range map[string]string{"core.sidebar.section.header": "list", "core.sidebar.tabs": "tabs"} {
		t.Run(layout, func(t *testing.T) {
			var calls []call
			var text ui.Color
			frame := listFrame()
			frame.Layout, frame.Tab = layout, "files.tree"
			binder := recorder(t, &calls, sidebarCommands...)
			tt := ui.NewTester(func(c *ui.Context) {
				text = c.Theme().Text
				ui.Box(c).Size(240, 400).Background(ui.RGB(0xff, 0xff, 0xff)).Children(func() {
					workbench.DrawSidebar(c, binder, &workbench.SectionDrag{}, frame, sidebarMetrics, 240, 400, func(*ui.Context, workbench.SidebarSeat) {})
				})
			}, 240, 400)
			item := "left"
			if layout == "list" {
				item = "left/files.tree"
			}
			box := element(t, tt, name, item).Bounds
			scale := float32(tt.Image().Bounds().Dx()) / 240
			x, y := int((box.X+box.W-4)*scale), int((box.Y+box.H/2)*scale)
			body := color.RGBA{0xff, 0xff, 0xff, 255}
			if got, want := tt.Image().RGBAAt(x, y), bandColor(body, text, sidebarMetrics.SectionHeadMix); !near(got, want) {
				t.Fatalf("the band is %v, want %v", got, want)
			}
			if layout != "list" {
				return
			}
			tt.Move(box.X+box.W-4, box.Y+box.H/2)
			tt.Frame()
			if got, want := tt.Image().RGBAAt(x, y), bandColor(body, text, sidebarMetrics.SectionHeadHoverMix); !near(got, want) {
				t.Fatalf("the band under the pointer is %v, want %v", got, want)
			}
		})
	}
}
