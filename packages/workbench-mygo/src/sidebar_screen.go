package workbench

import (
	"encoding/json"
	"math"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The frame of a sidebar (docs/spec/plugins.md#sections): the section headers with their names, folding, the tabs, the
// heights and the status line. The plugin draws the body of a section in a section surface, whose native view stands on the
// seat that this frame gives it.

const (
	sectionHeightMin = 32
	sectionHeightMax = 4096
)

var (
	chevronDown  = chevronIcon("m6 9 6 6 6-6")
	chevronRight = chevronIcon("m9 18 6-6-6-6")
	chevronLeft  = chevronIcon("m15 18-6-6 6-6")
)

// chevronIcon is the stroke icon of the path d, as packages/workbench/icons.js holds it.
func chevronIcon(d string) *ui.SVG { return strokeIcon(`<path d="` + d + `"/>`) }

// strokeIcon is the stroke icon of the shapes of body.
func strokeIcon(body string) *ui.SVG {
	return ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#888" ` +
		`stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` + body + `</svg>`))
}

// SidebarMetrics are the chrome metrics of workbench.json that the frame reads, in points.
type SidebarMetrics struct {
	HeadH          float32
	FootH          float32
	SectionMinH    float32
	SectionDivider float32
	// SectionHeadGap, SectionHeadPad and SectionHeadText are the gap, the side padding and the text size of a section header.
	SectionHeadGap  float32
	SectionHeadPad  float32
	SectionHeadText float32
	// SectionTabMark is the height of the mark of the selected tab of a `tabs` set.
	SectionTabMark float32
	// FoldButton and FoldIcon are the sizes of the fold control of a status line and of its icon.
	FoldButton float32
	FoldIcon   float32
}

// SidebarSection is a section of the set that a sidebar shows.
type SidebarSection struct {
	ID     string
	Name   string
	Plugin string
	// Height is the declared height of a section that does not fill.
	Height int
	// Fill is the declared height `fill`.
	Fill bool
	// Size is the height that the person dragged the section to, which replaces the declared height.
	Size   *int
	Folded bool
	// Composition is the composition that the section declares.
	Composition json.RawMessage
}

// SidebarFrame is what a sidebar draws.
type SidebarFrame struct {
	// Sidebar is `left`, `right` or `<card>:<side>`.
	Sidebar string
	Space   string
	// Layout is `list` or `tabs`.
	Layout string
	// Orientation is `vertical` or `horizontal`.
	Orientation string
	// Tab is the selected section of a `tabs` set.
	Tab string
	// Side is `left` or `right` for a window sidebar and empty for a card sidebar.
	Side     string
	Status   string
	Sections []SidebarSection
	// Rail is the color of the mark of the selected tab.
	Rail ui.Color
}

// SidebarSeat is the seat of a section surface. A folded section and a section of an unselected tab keep their surface,
// which is not visible.
type SidebarSeat struct {
	SurfaceID string
	Section   string
	Sidebar   string
	Plugin    string
	Title     string
	// Composition is the composition that the section declares.
	Composition json.RawMessage
	Visible     bool
	// Box is the body of the section, from the top left of the sidebar. A seat that is not visible has an empty box.
	Box layout.Rect
}

// SectionDrag is the drag of a divider. It lives across builds, so the shell keeps one for each sidebar.
type SectionDrag struct {
	divider int
	dragged bool
	start   float32
	room    float32
	moved   float32
}

// SidebarSeats returns the seat of each section of the frame, in the order of the set.
func SidebarSeats(frame SidebarFrame) []SidebarSeat {
	seats := make([]SidebarSeat, len(frame.Sections))
	for i, section := range frame.Sections {
		seats[i] = seatOf(frame, section)
	}
	return seats
}

func seatOf(frame SidebarFrame, section SidebarSection) SidebarSeat {
	visible := !section.Folded
	if frame.Layout == "tabs" {
		visible = section.ID == frame.Tab
	}
	return SidebarSeat{
		SurfaceID: frame.Space + "/" + frame.Sidebar + "/" + section.ID, Sidebar: frame.Sidebar,
		Section: section.ID, Plugin: section.Plugin, Title: section.Name, Composition: section.Composition, Visible: visible,
	}
}

func (s SidebarSection) fills() bool { return s.Fill && s.Size == nil }

func (s SidebarSection) points() float32 {
	if s.Size != nil {
		return float32(*s.Size)
	}
	return float32(s.Height)
}

// SectionHeights returns the height of the body of each section of a vertical list in a set of the height room: the open
// section with a height has it, fill sections share what the other sections leave and keep their head and the minimum
// height, and a section with a height gives way when the set is shorter, because a view is a native view that no overflow
// clips (docs/spec/plugins.md#sections).
func SectionHeights(sections []SidebarSection, metrics SidebarMetrics, room float32) []float32 {
	fixed, shrinking, fills := float32(0), float32(0), 0
	for _, section := range sections {
		switch {
		case section.Folded:
			fixed += metrics.HeadH
		case section.fills():
			fills++
		default:
			fixed += metrics.HeadH + section.points()
			shrinking += metrics.HeadH + section.points()
		}
	}
	least := metrics.HeadH + metrics.SectionMinH
	share := least
	if fills > 0 {
		share = max(least, (room-fixed)/float32(fills))
	}
	over := fixed + float32(fills)*least - room
	if fills > 0 && share > least {
		over = 0
	}
	scale := float32(1)
	if over > 0 && shrinking > 0 {
		scale = max(0, 1-over/shrinking)
	}
	heights := make([]float32, len(sections))
	for i, section := range sections {
		switch {
		case section.Folded:
			heights[i] = 0
		case section.fills():
			heights[i] = share - metrics.HeadH
		default:
			heights[i] = max(0, (metrics.HeadH+section.points())*scale-metrics.HeadH)
		}
	}
	return heights
}

// sectionParam is the parameter of the commands of a section.
type sectionParam struct {
	Sidebar string `json:"sidebar"`
	Section string `json:"section"`
}

// sectionSizeParam is the parameter of core.sidebar.section.size.
type sectionSizeParam struct {
	Sidebar string `json:"sidebar"`
	Section string `json:"section"`
	Height  int    `json:"height"`
}

// settingsPatchParam is the parameter of core.settings.set.
type settingsPatchParam struct {
	Patch map[string]any `json:"patch"`
}

// seatDrawer draws what stands on a seat. It runs for every section of the sidebar, so a seat that is not visible stays known.
type seatDrawer func(c *ui.Context, seat SidebarSeat)

// sectionItem tells the elements of the section apart from the same elements of another sidebar.
func sectionItem(frame SidebarFrame, section SidebarSection) string {
	return frame.Sidebar + "/" + section.ID
}

// DrawSidebar draws the sidebar of the frame in a box of width and height. seat runs in the body of an open section, where the
// native view of the section surface stands, and at the end for each section that is not visible.
func DrawSidebar(c *ui.Context, binder *Binder, drag *SectionDrag, frame SidebarFrame, metrics SidebarMetrics, width, height float32, seat seatDrawer) {
	room := height - metrics.FootH
	ui.Column(binder.Name(c, "core.sidebar", frame.Sidebar)).Size(width, height).Role(ui.RoleGroup).Label(frame.Sidebar).Clip().Children(func() {
		// The set takes all the room, so a set of short sections leaves the status line at the bottom.
		ui.Column(c).Size(width, room).Children(func() {
			switch {
			case frame.Layout == "tabs":
				drawSectionTabs(c, binder, frame, metrics, width, room, seat)
			case frame.Orientation == "horizontal":
				drawHorizontalList(c, binder, frame, metrics, width, room, seat)
			default:
				drawVerticalList(c, binder, drag, frame, metrics, width, room, seat)
			}
		})
		drawSidebarStatus(c, binder, frame, metrics)
	})
	for _, place := range SidebarSeats(frame) {
		if !place.Visible {
			seat(c, place)
		}
	}
}

func drawSectionHeader(c *ui.Context, binder *Binder, frame SidebarFrame, section SidebarSection, metrics SidebarMetrics) {
	theme := c.Theme()
	item := sectionItem(frame, section)
	// A list item keeps the name as an element of its own, which a button takes as its text.
	header := binder.Press(c, "core.sidebar.section.header", "core.sidebar.section.fold", item, sectionParam{frame.Sidebar, section.ID}).
		Role(ui.RoleListItem).Label(section.Name).Height(metrics.HeadH).FillWidth().Row().
		Justify(ui.Start).AlignItems(ui.Center).Gap(metrics.SectionHeadGap).PaddingX(metrics.SectionHeadPad).Expanded(!section.Folded).
		BorderWidth(0, 0, 1, 0).BorderColor(theme.Border)
	if header.Hovered() {
		header.Background(theme.Surface)
	}
	header.Children(func() {
		icon := chevronDown
		if section.Folded {
			icon = chevronRight
		}
		ui.Icon(c, icon).Size(metrics.SectionHeadText, metrics.SectionHeadText)
		ui.Text(binder.Name(c, "core.sidebar.section.name", item), section.Name).Label(section.Name).SingleLine().Ellipsis("…").FontSize(metrics.SectionHeadText).Bold().TextColor(theme.Text)
	})
}

// drawSeat draws the body of the section, which is the seat of its section surface, at box.
func drawSeat(c *ui.Context, frame SidebarFrame, section SidebarSection, box layout.Rect, seat seatDrawer) {
	place := seatOf(frame, section)
	place.Box = box
	ui.Box(c).Key(place.SurfaceID).Role(ui.RoleGroup).Label(place.Title).Size(float32(box.W), float32(box.H)).Children(func() { seat(c, place) })
}

func drawVerticalList(c *ui.Context, binder *Binder, drag *SectionDrag, frame SidebarFrame, metrics SidebarMetrics, width, room float32, seat seatDrawer) {
	heights := SectionHeights(frame.Sections, metrics, room)
	ui.Scroll(c).Size(width, room).Children(func() {
		ui.Column(c).Width(width).Children(func() {
			y := float32(0)
			starts := make([]float32, len(frame.Sections))
			for i, section := range frame.Sections {
				starts[i] = y
				ui.Column(binder.Name(c, "core.sidebar.section", sectionItem(frame, section))).FillWidth().Role(ui.RoleGroup).Label(section.Name).Children(func() {
					drawSectionHeader(c, binder, frame, section, metrics)
					if !section.Folded {
						drawSeat(c, frame, section, layout.Rect{Y: float64(y + metrics.HeadH), W: float64(width), H: float64(heights[i])}, seat)
					}
				})
				y += metrics.HeadH + heights[i]
			}
			// A divider lies over the top of the head below it, which the page draws, so a view never covers it.
			for i := 1; i < len(frame.Sections); i++ {
				if !frame.Sections[i-1].Folded && !frame.Sections[i].Folded {
					drawDivider(c, binder, drag, frame, i, heights, starts[i], width, metrics)
				}
			}
		})
	})
}

// drawDivider draws the divider above the section below, and passes its drag to `core.sidebar.section.size` at each move. It
// sizes the section below when that section has an integer height, and otherwise the section above, and keeps the other
// section of the divider at least the minimum height.
func drawDivider(c *ui.Context, binder *Binder, drag *SectionDrag, frame SidebarFrame, below int, heights []float32, top, width float32, metrics SidebarMetrics) {
	target, other, sign := below, below-1, float32(-1)
	if frame.Sections[below].fills() {
		target, other, sign = below-1, below, 1
	}
	run := binder.Control(c, "core.sidebar.section.divider", "core.sidebar.section.size", sectionItem(frame, frame.Sections[below]))
	divider := ui.Box(c).Absolute().Left(0).Top(top).Size(width, metrics.SectionDivider).
		Role(ui.RoleSplitter).Label(frame.Sections[target].Name).Cursor(ui.CursorResizeNS)
	_, dy, pressed := divider.Dragged()
	if !pressed {
		if drag.divider == below {
			drag.dragged = false
		}
		return
	}
	if !drag.dragged || drag.divider != below {
		*drag = SectionDrag{divider: below, dragged: true, start: heights[target], room: heights[target] + heights[other]}
	}
	if dy == 0 {
		return
	}
	drag.moved += sign * dy
	size := min(sectionHeightMax, drag.room-sectionHeightMin, max(sectionHeightMin, drag.start+drag.moved))
	run(sectionSizeParam{frame.Sidebar, frame.Sections[target].ID, int(math.Round(float64(size)))})
}

// drawHorizontalList divides the width equally among the open sections within the height of the set.
func drawHorizontalList(c *ui.Context, binder *Binder, frame SidebarFrame, metrics SidebarMetrics, width, room float32, seat seatDrawer) {
	open := 0
	for _, section := range frame.Sections {
		if !section.Folded {
			open++
		}
	}
	share, x := float32(0), float32(0)
	if open > 0 {
		share = (width - float32(len(frame.Sections)-open)*metrics.HeadH) / float32(open)
	}
	ui.Row(c).Size(width, room).Children(func() {
		for _, section := range frame.Sections {
			wide := metrics.HeadH
			if !section.Folded {
				wide = share
			}
			ui.Column(binder.Name(c, "core.sidebar.section", sectionItem(frame, section))).Width(wide).FillHeight().Role(ui.RoleGroup).Label(section.Name).Children(func() {
				drawSectionHeader(c, binder, frame, section, metrics)
				if !section.Folded {
					drawSeat(c, frame, section, layout.Rect{X: float64(x), Y: float64(metrics.HeadH), W: float64(wide), H: float64(room - metrics.HeadH)}, seat)
				}
			})
			x += wide
		}
	})
}

// drawSectionTabs draws the row of tabs and only the section of the selected tab.
func drawSectionTabs(c *ui.Context, binder *Binder, frame SidebarFrame, metrics SidebarMetrics, width, room float32, seat seatDrawer) {
	theme := c.Theme()
	// The set keeps the height of the room, so a section with an integer height leaves the status line at the end of the sidebar.
	ui.Column(c).Size(width, room).Children(func() {
		ui.ScrollHorizontal(binder.Name(c, "core.sidebar.tabs", frame.Sidebar)).Size(width, metrics.HeadH).Role(ui.RoleTabList).Children(func() {
			ui.Row(c).FillHeight().Children(func() {
				for _, section := range frame.Sections {
					drawSectionTab(c, binder, frame, section, metrics, theme)
				}
			})
		})
		for _, section := range frame.Sections {
			height := room - metrics.HeadH
			if !section.fills() {
				height = min(height, section.points())
			}
			ui.Column(binder.Name(c, "core.sidebar.section", sectionItem(frame, section))).Hidden(section.ID != frame.Tab).Role(ui.RoleGroup).Label(section.Name).Children(func() {
				if section.ID == frame.Tab {
					drawSeat(c, frame, section, layout.Rect{Y: float64(metrics.HeadH), W: float64(width), H: float64(height)}, seat)
				}
			})
		}
	})
}

// drawSectionTab draws the tab of section. Selected tells that the tab is chosen and paints the accent color, which the plain
// background replaces: the selected tab differs in its text color and its rail mark.
func drawSectionTab(c *ui.Context, binder *Binder, frame SidebarFrame, section SidebarSection, metrics SidebarMetrics, theme *ui.Theme) {
	selected := section.ID == frame.Tab
	color := theme.TextMuted
	if selected {
		color = theme.Text
	}
	tab := binder.Press(c, "core.sidebar.section.tab", "core.sidebar.section.select", sectionItem(frame, section), sectionParam{frame.Sidebar, section.ID}).
		Role(ui.RoleTab).Selected(selected).FillHeight().Background(ui.Transparent)
	if tab.Hovered() {
		tab.Background(theme.Surface)
	}
	tab.Children(func() {
		ui.Text(c, section.Name).NoWrap().FontSize(metrics.SectionHeadText).Bold().TextColor(color).Padding(0, metrics.SectionHeadPad)
		if selected {
			ui.Box(c).Absolute().Left(0).Right(0).Bottom(0).Height(metrics.SectionTabMark).Background(frame.Rail)
		}
	})
}

func drawSidebarStatus(c *ui.Context, binder *Binder, frame SidebarFrame, metrics SidebarMetrics) {
	theme := c.Theme()
	name := "core.card.sidebar.status"
	if frame.Side != "" {
		name = "core.sidebar.status"
	}
	ui.Row(binder.Name(c, name, frame.Sidebar)).FillWidth().Height(metrics.FootH).AlignItems(ui.Center).Gap(6).PaddingX(8).
		BorderWidth(1, 0, 0, 0).BorderColor(theme.Border).Role(ui.RoleStatus).Label(frame.Status).Children(func() {
		ui.Text(c, frame.Status).SingleLine().Ellipsis("…").MinWidth(0).Shrink(1).Grow(1).FontSize(10).TextColor(theme.TextMuted)
		if frame.Side == "" {
			return
		}
		icon := chevronLeft
		title := "왼쪽 창 사이드바 접기"
		if frame.Side == "right" {
			icon, title = chevronRight, "오른쪽 창 사이드바 접기"
		}
		binder.Press(c, "core.sidebar.fold", "core.settings.set", frame.Side, settingsPatchParam{map[string]any{frame.Side: false}}).Label(title).Size(metrics.FoldButton, metrics.FoldButton).Children(func() {
			ui.Icon(c, icon).Size(metrics.FoldIcon, metrics.FoldIcon)
		})
	})
}
