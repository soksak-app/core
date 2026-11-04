package workbench

import (
	"math"

	"github.com/egoist/mygo/ui"
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
func chevronIcon(d string) *ui.SVG {
	return ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#888" ` +
		`stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="` + d + `"/></svg>`))
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
}

// SidebarSeat is the seat of a section surface. A folded section and a section of an unselected tab keep their surface,
// which is not visible.
type SidebarSeat struct {
	SurfaceID string
	Section   string
	Plugin    string
	Title     string
	Visible   bool
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
		SurfaceID: frame.Space + "/" + frame.Sidebar + "/" + section.ID,
		Section:   section.ID, Plugin: section.Plugin, Title: section.Name, Visible: visible,
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

// DrawSidebar draws the sidebar of the frame in a box of width and height. seat draws in the body of an open section, where
// the native view of the section surface stands.
func DrawSidebar(c *ui.Context, names *ElementNames, drag *SectionDrag, frame SidebarFrame, metrics SidebarMetrics, width, height float32,
	run RunCommand, seat func(c *ui.Context, seat SidebarSeat)) {
	room := height - metrics.FootH
	ui.Column(c.Key(names.Next("core.sidebar"))).Size(width, height).Role(ui.RoleGroup).Label(frame.Sidebar).Clip().Children(func() {
		switch {
		case frame.Layout == "tabs":
			drawSectionTabs(c, names, frame, metrics, width, room, run, seat)
		case frame.Orientation == "horizontal":
			drawHorizontalList(c, names, frame, metrics, width, room, run, seat)
		default:
			drawVerticalList(c, names, drag, frame, metrics, width, room, run, seat)
		}
		drawSidebarStatus(c, names, frame, metrics, run)
	})
}

func drawSectionHeader(c *ui.Context, names *ElementNames, frame SidebarFrame, section SidebarSection, metrics SidebarMetrics, run RunCommand) {
	theme := c.Theme()
	// A list item keeps the name as an element of its own, which a button takes as its text.
	header := ui.Row(c.Key(names.Next("core.sidebar.section.header"))).Role(ui.RoleListItem).Label(section.Name).Height(metrics.HeadH).FillWidth().
		AlignItems(ui.Center).Gap(metrics.SectionHeadGap).PaddingX(metrics.SectionHeadPad).Expanded(!section.Folded)
	if header.Hovered() {
		header.Background(theme.Surface)
	}
	header.Children(func() {
		icon := chevronDown
		if section.Folded {
			icon = chevronRight
		}
		ui.Icon(c, icon).Size(metrics.SectionHeadText, metrics.SectionHeadText)
		ui.Text(c, section.Name).Key(names.Next("core.sidebar.section.name")).Label(section.Name).NoWrap().Ellipsis("…").FontSize(metrics.SectionHeadText).Bold().TextColor(theme.Text)
	})
	if header.Clicked() {
		run("core.sidebar.section.fold", map[string]any{"sidebar": frame.Sidebar, "section": section.ID})
	}
}

// drawSeat draws the body of the section, which is the seat of its section surface.
func drawSeat(c *ui.Context, frame SidebarFrame, section SidebarSection, body func(*ui.Element), seat func(*ui.Context, SidebarSeat)) {
	place := seatOf(frame, section)
	element := ui.Box(c).Key(place.SurfaceID).Role(ui.RoleGroup).Label(place.Title)
	body(&element)
	element.Children(func() { seat(c, place) })
}

func drawVerticalList(c *ui.Context, names *ElementNames, drag *SectionDrag, frame SidebarFrame, metrics SidebarMetrics, width, room float32,
	run RunCommand, seat func(*ui.Context, SidebarSeat)) {
	heights := SectionHeights(frame.Sections, metrics, room)
	ui.Scroll(c).Size(width, room).Children(func() {
		ui.Column(c).Width(width).Children(func() {
			y := float32(0)
			starts := make([]float32, len(frame.Sections))
			for i, section := range frame.Sections {
				starts[i] = y
				ui.Column(c.Key(names.Next("core.sidebar.section"))).FillWidth().Role(ui.RoleGroup).Label(section.Name).Children(func() {
					drawSectionHeader(c, names, frame, section, metrics, run)
					if !section.Folded {
						drawSeat(c, frame, section, func(e *ui.Element) { e.Size(width, heights[i]) }, seat)
					}
				})
				y += metrics.HeadH + heights[i]
			}
			// A divider lies over the top of the head below it, which the page draws, so a view never covers it.
			for i := 1; i < len(frame.Sections); i++ {
				if !frame.Sections[i-1].Folded && !frame.Sections[i].Folded {
					drawDivider(c, names, drag, frame, i, heights, starts[i], width, metrics, run)
				}
			}
		})
	})
}

// drawDivider draws the divider above the section below, and passes its drag to `core.sidebar.section.size` at each move. It
// sizes the section below when that section has an integer height, and otherwise the section above, and keeps the other
// section of the divider at least the minimum height.
func drawDivider(c *ui.Context, names *ElementNames, drag *SectionDrag, frame SidebarFrame, below int, heights []float32, top, width float32,
	metrics SidebarMetrics, run RunCommand) {
	target, other, sign := below, below-1, float32(-1)
	if frame.Sections[below].fills() {
		target, other, sign = below-1, below, 1
	}
	divider := ui.Box(c.Key(names.Next("core.sidebar.section.divider"))).Absolute().Left(0).Top(top).Size(width, metrics.SectionDivider).
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
	run("core.sidebar.section.size", map[string]any{"sidebar": frame.Sidebar, "section": frame.Sections[target].ID, "height": int(math.Round(float64(size)))})
}

// drawHorizontalList divides the width equally among the open sections within the height of the set.
func drawHorizontalList(c *ui.Context, names *ElementNames, frame SidebarFrame, metrics SidebarMetrics, width, room float32,
	run RunCommand, seat func(*ui.Context, SidebarSeat)) {
	ui.Row(c).Size(width, room).Children(func() {
		for _, section := range frame.Sections {
			column := ui.Column(c.Key(names.Next("core.sidebar.section"))).FillHeight().Role(ui.RoleGroup).Label(section.Name)
			if !section.Folded {
				column = column.Grow(1).Width(0)
			}
			column.Children(func() {
				drawSectionHeader(c, names, frame, section, metrics, run)
				if !section.Folded {
					drawSeat(c, frame, section, func(e *ui.Element) { e.Grow(1).FillWidth() }, seat)
				}
			})
		}
	})
}

// drawSectionTabs draws the row of tabs and only the section of the selected tab.
func drawSectionTabs(c *ui.Context, names *ElementNames, frame SidebarFrame, metrics SidebarMetrics, width, room float32,
	run RunCommand, seat func(*ui.Context, SidebarSeat)) {
	theme := c.Theme()
	ui.ScrollHorizontal(c.Key(names.Next("core.sidebar.tabs"))).Size(width, metrics.HeadH).Role(ui.RoleTabList).Children(func() {
		ui.Row(c).FillHeight().Children(func() {
			for _, section := range frame.Sections {
				selected := section.ID == frame.Tab
				color := theme.TextMuted
				if selected {
					color = theme.Text
				}
				tab := ui.ButtonBase(c.Key(names.Next("core.sidebar.section.tab"))).Role(ui.RoleTab).Selected(selected).FillHeight().Children(func() {
					ui.Text(c, section.Name).NoWrap().FontSize(metrics.SectionHeadText).Bold().TextColor(color).Padding(0, metrics.SectionHeadPad)
				})
				if tab.Clicked() {
					run("core.sidebar.section.select", map[string]any{"sidebar": frame.Sidebar, "section": section.ID})
				}
			}
		})
	})
	for _, section := range frame.Sections {
		height := room - metrics.HeadH
		if !section.fills() {
			height = min(height, section.points())
		}
		ui.Column(c.Key(names.Next("core.sidebar.section"))).Hidden(section.ID != frame.Tab).Role(ui.RoleGroup).Label(section.Name).Children(func() {
			if section.ID == frame.Tab {
				drawSeat(c, frame, section, func(e *ui.Element) { e.Size(width, height) }, seat)
			}
		})
	}
}

func drawSidebarStatus(c *ui.Context, names *ElementNames, frame SidebarFrame, metrics SidebarMetrics, run RunCommand) {
	theme := c.Theme()
	name := "core.card.sidebar.status"
	if frame.Side != "" {
		name = "core.sidebar.status"
	}
	ui.Row(c.Key(names.Next(name))).FillWidth().Height(metrics.FootH).AlignItems(ui.Center).Gap(6).PaddingX(8).Role(ui.RoleStatus).Label(frame.Status).Children(func() {
		ui.Text(c, frame.Status).NoWrap().Ellipsis("…").TextColor(theme.TextMuted).Grow(1)
		if frame.Side == "" {
			return
		}
		icon := chevronLeft
		title := "왼쪽 창 사이드바 접기"
		if frame.Side == "right" {
			icon, title = chevronRight, "오른쪽 창 사이드바 접기"
		}
		fold := ui.ButtonBase(c.Key(names.Next("core.sidebar.fold"))).Label(title).Size(16, 16).Children(func() {
			ui.Icon(c, icon).Size(12, 12)
		})
		if fold.Clicked() {
			run("core.settings.set", map[string]any{"patch": map[string]any{frame.Side: false}})
		}
	})
}
