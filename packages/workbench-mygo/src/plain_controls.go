package workbench

import (
	"fmt"

	"github.com/egoist/mygo/ui"
)

// The symbols of the system that the browser draws in a search.
const (
	searchSymbol = "magnifyingglass"
	cancelSymbol = "xmark.circle.fill"
)

// systemSymbol reads a symbol of the system. Every system that the host deploys to has these symbols, so a missing one ends the
// program as an undeclared name does.
func systemSymbol(c *ui.Context, name string, pointSize float32) ui.Symbol {
	symbol := c.SystemSymbol(name, pointSize)
	if symbol.Bitmap == nil {
		panic(fmt.Sprintf("the system has no symbol %s", name))
	}
	return symbol
}

// PlainControls is the look of an input and a select of the page without a rule of their own: the controls of the color scheme of
// the page, as WebKit draws them. The declaration holds what a window of the page measures.
type PlainControls struct {
	Background, Edge, Fg, Placeholder, SelectFill, SelectFg, Muted ui.Color
	Font                                                           string
	Size, Figures                                                  float32
	EdgeW, PadX, PadY, Radius, Height                              float32
	SelectH, SelectPad, SelectRoom, SelectRadius, Halo             float32
	ArrowsW, ArrowsH, ArrowsEnd                                    float32
	PanelGap, PanelRadius, PanelEdgeW                              float32
	PanelFill, PanelEdge                                           ui.Color
	Arrows                                                         *ui.SVG
	// RingW is the width of the ring of the browser around a focused control. Its color is that of the system (ringColor), and
	// Focus takes its place on a desktop without one.
	RingW float32
	Focus ui.Color
	// The search: an input of type search, whose magnifier and cancel the browser draws in colors of their own, whatever the color
	// of the text is. Inset lies between its box and its pill.
	SearchIcon, SearchCancel                                             ui.Color
	SearchInset, SearchTextX, SearchTextEnd, SearchIconX, SearchIconSize float32
	SearchCancelPt, SearchIconPt, SearchCancelSize, SearchCancelEnd      float32
}

// plainControls reads the look from the declaration.
func (s *Shell) plainControls() PlainControls {
	declared := s.options.Declared
	metric := func(name string) float32 {
		return float32(declared.PlainNumber(name, "px"))
	}
	chrome := func(name string) float32 {
		return float32(declared.ChromeNumber(name, "px"))
	}
	color := func(name string) ui.Color { return ui.Hex(declared.PlainControl(name)) }
	figures := declared.PlainNumber("text-w", "ch")
	size := float32(s.settings.Value("size").(float64))
	stroke := `fill="none" stroke="currentColor" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"`
	return PlainControls{Background: color("bg"), Edge: color("edge"), Fg: color("fg"),
		Placeholder: color("placeholder"), SelectFill: color("select-bg"), SelectFg: color("select-fg"), Muted: s.palette.Muted,
		Font: s.fontFamily(), Size: size, Figures: float32(figures),
		EdgeW: metric("edge-w"), PadX: metric("pad-x"), PadY: metric("pad-y"), Radius: metric("r"),
		Height:  float32(chrome("line-height"))*size + 2*(metric("pad-y")+metric("edge-w")),
		SelectH: metric("select-h"), SelectPad: metric("select-pad"), SelectRoom: metric("select-room"),
		SelectRadius: metric("select-r"), Halo: metric("select-halo"), ArrowsW: metric("select-arrows-w"), ArrowsH: metric("select-arrows-h"), ArrowsEnd: metric("select-arrows-end"),
		PanelGap: chrome("space-1"), PanelRadius: s.radiusSmall(), PanelEdgeW: s.palette.BorderWidth,
		RingW: metric("ring-w"), Focus: s.palette.Focus, SearchIcon: color("search-icon"), SearchCancel: color("search-cancel"),
		SearchInset: metric("search-inset"), SearchTextX: metric("search-text-x"), SearchTextEnd: metric("search-text-end"),
		SearchIconX: metric("search-icon-x"), SearchIconSize: metric("search-icon-size"), SearchCancelPt: metric("search-cancel-pt"), SearchIconPt: metric("search-icon-pt"), SearchCancelSize: metric("search-cancel-size"), SearchCancelEnd: metric("search-cancel-end"),
		PanelFill: s.palette.Card, PanelEdge: s.palette.Edge,
		Arrows: s.declaredIcon("0 0 7.5 10", fmt.Sprintf(stroke, "1.1"), declared.Icons["control-select-arrows"])}
}

// ringColor is the focus color of the system in the appearance of the page, which follows the accent color.
func (p PlainControls) ringColor(c *ui.Context) ui.Color {
	if ring := c.Preferences().DarkFocusRing; ring.A != 0 {
		return ring
	}
	return p.Focus
}

// ring draws the ring of the browser around box, whose corners have radius.
func (p PlainControls) ring(painter *ui.Painter, box ui.Rect, radius float32, color ui.Color) {
	painter.Stroke(ui.Rect{X: box.X - p.RingW, Y: box.Y - p.RingW, W: box.W + 2*p.RingW, H: box.H + 2*p.RingW}, color, radius+p.RingW, p.RingW)
}

// textWidth is the width of text in the font of the controls.
func (p PlainControls) textWidth(c *ui.Context, text string) float32 {
	return spanWidth(c, ui.Span{Text: text, Size: p.Size, Font: p.Font})
}

// field gives a text field the look of an input: it starts as wide as twenty figures, the size that an input takes by default,
// and the browser rings it while it has the focus.
func (p PlainControls) field(c *ui.Context, field ui.Element) ui.Element {
	focused, ring := field.Focused(), p.ringColor(c)
	return field.Basis(p.Figures*p.textWidth(c, "0")+2*(p.PadX+p.EdgeW)).Height(p.Height).Padding(p.PadY, p.PadX, p.PadY, p.PadX).
		Border(p.EdgeW, p.Edge).Radius(p.Radius).Background(p.Background).TextColor(p.Fg).PlaceholderColor(p.Placeholder).FontSize(p.Size).
		DrawOver(func(painter *ui.Painter, box ui.Rect) {
			if focused {
				p.ring(painter, box, p.Radius, ring)
			}
		})
}

// search gives a text field the look of an input of type search: the whole field, with a pill inside it by the inset and a magnifier
// in front of the text. The ring of the browser goes around the field while it has the focus.
func (p PlainControls) search(c *ui.Context, field ui.Element) ui.Element {
	focused, ring := field.Focused(), p.ringColor(c)
	inset, height := p.SearchInset, p.Height-2*p.SearchInset
	padY := p.PadY + p.EdgeW
	magnifier := systemSymbol(c, searchSymbol, p.SearchIconPt)
	return field.FillWidth().Height(p.Height).Padding(padY, p.SearchTextEnd+inset, padY, p.SearchTextX+inset).
		Draw(func(painter *ui.Painter, box ui.Rect) {
			painter.Fill(ui.Rect{X: box.X + inset, Y: box.Y + inset, W: box.W - 2*inset, H: box.H - 2*inset}, p.Background, height/2)
		}).
		TextColor(p.Fg).PlaceholderColor(p.Placeholder).FontSize(p.Size).DrawOver(func(painter *ui.Painter, box ui.Rect) {
		painter.Symbol(magnifier, ui.Rect{X: box.X + inset + p.SearchIconX, Y: box.Y + (box.H-p.SearchIconSize)/2, W: p.SearchIconSize, H: p.SearchIconSize}, p.SearchIcon)
		if focused {
			p.ring(painter, box, p.Height/2, ring)
		}
	})
}

// searchBox is the box of a search, which takes the free width of its row as the input does in its grid column.
func (p PlainControls) searchBox(c *ui.Context) ui.Element {
	return ui.Box(c).Grow(1).Basis(0)
}

// drawSearchCancel draws the cancel of a search with a text, and reports its press. It takes no focus, as that of the browser.
func (p PlainControls) drawSearchCancel(c *ui.Context) bool {
	cancel := ui.Box(c).Absolute().Right(p.SearchInset+p.SearchCancelEnd).Top((p.Height-p.SearchCancelSize)/2).Size(p.SearchCancelSize, p.SearchCancelSize).
		Role(ui.RoleButton).Label("cancel")
	symbol := systemSymbol(c, cancelSymbol, p.SearchCancelPt)
	cancel.Draw(func(painter *ui.Painter, box ui.Rect) { painter.Symbol(symbol, box, p.SearchCancel) })
	return cancel.Clicked()
}

// drawSelect draws a select as wide as its longest option, and reports that the value changed.
func (p PlainControls) drawSelect(c *ui.Context, binder *Binder, name, label string, value *string, options []string) bool {
	var longest float32
	for _, option := range options {
		longest = max(longest, p.textWidth(c, option))
	}
	selector := ui.SelectBase(c, value)
	binder.Bound(selector.Trigger, name)
	ringed, ring := selector.Trigger.FocusVisible(), p.ringColor(c)
	selector.Trigger.FocusRing(false).Width(longest+p.SelectRoom).Height(p.SelectH).Row().AlignItems(ui.Center).Padding(0, 0, 0, p.SelectPad).
		Radius(p.SelectRadius).Border(p.Halo, p.Background).Background(p.SelectFill).Label(label).DrawOver(func(painter *ui.Painter, box ui.Rect) {
		if ringed {
			p.ring(painter, box, p.SelectRadius, ring)
		}
	}).Children(func() {
		ui.Text(c, *value).FontSize(p.Size).TextColor(p.SelectFg).Font(p.Font).NoWrap().Grow(1)
		if p.Arrows != nil {
			ui.Icon(c, p.Arrows).Size(p.ArrowsW, p.ArrowsH).TextColor(p.SelectFg).MarginEnd(p.ArrowsEnd)
		}
	})
	selector.Popup(func(panel ui.Element) {
		panel.Padding(p.PanelGap).Background(p.PanelFill).Border(p.PanelEdgeW, p.PanelEdge).Radius(p.PanelRadius).Column()
		// Options past the room of the window scroll, as those of a select of the page do.
		trigger := selector.Trigger.Bounds()
		_, height := c.Size()
		ui.Scroll(c).FillWidth().MaxHeight(max(0, height-trigger.Y-trigger.H-2*p.PanelGap)).Children(func() {
			for _, option := range options {
				item := selector.Item(option).Padding(p.PanelGap, p.SelectPad).AlignItems(ui.Center)
				if item.Highlighted() {
					item.Background(p.PanelEdge)
				}
				item.Children(func() { ui.Text(c, option).FontSize(p.Size).TextColor(p.SelectFg) })
			}
		})
	})
	return selector.Trigger.Changed()
}
