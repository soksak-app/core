package workbench

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
)

// PlainControls is the look of an input and a select of the page without a rule of their own: the controls of the color scheme of
// the page, as WebKit draws them. The declaration holds what a window of the page measures.
type PlainControls struct {
	Background, Edge, Fg, Placeholder, SelectFill, Muted ui.Color
	Font                                                 string
	Size, Figures                                        float32
	EdgeW, PadX, PadY, Radius, Height                    float32
	SelectH, SelectPad, SelectRoom, SelectRadius, Halo   float32
	PanelGap, PanelRadius, PanelEdgeW                    float32
	PanelFill, PanelEdge                                 ui.Color
	Arrows                                               *ui.SVG
}

// plainControls reads the look from the declaration.
func (s *Shell) plainControls() PlainControls {
	declared := s.options.Declared
	metric := func(name string) float32 {
		value, _ := strconv.ParseFloat(strings.TrimSuffix(declared.PlainControl(name), "px"), 32)
		return float32(value)
	}
	chrome := func(name string) float32 {
		value, _ := declared.Metric(name)
		return float32(value)
	}
	color := func(name string) ui.Color { return ui.Hex(declared.PlainControl(name)) }
	figures, _ := strconv.ParseFloat(strings.TrimSuffix(declared.PlainControl("text-w"), "ch"), 32)
	return PlainControls{Background: color("bg"), Edge: color("edge"), Fg: color("fg"),
		Placeholder: color("placeholder"), SelectFill: color("select-bg"), Muted: s.palette.Muted,
		Font: s.fontFamily(), Size: float32(s.settings.Value("size").(float64)), Figures: float32(figures),
		EdgeW: metric("edge-w"), PadX: metric("pad-x"), PadY: metric("pad-y"), Radius: metric("r"), Height: metric("h"),
		SelectH: metric("select-h"), SelectPad: metric("select-pad"), SelectRoom: metric("select-room"),
		SelectRadius: metric("select-r"), Halo: metric("select-halo"), PanelGap: chrome("space-1"), PanelRadius: s.radiusSmall(), PanelEdgeW: s.palette.BorderWidth,
		PanelFill: s.palette.Card, PanelEdge: s.palette.Edge, Arrows: s.declaredIcon("0 0 16 16", `fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`, declared.Icons["control-select-arrows"])}
}

// textWidth is the width of text in the font of the controls.
func (p PlainControls) textWidth(c *ui.Context, text string) float32 {
	width, _ := c.MeasureText(0, ui.Span{Text: text, Size: p.Size, Font: p.Font})
	return width
}

// field gives a text field the look of an input: it starts as wide as twenty figures, the size that an input takes by default.
func (p PlainControls) field(c *ui.Context, field ui.Element) ui.Element {
	return field.Basis(p.Figures*p.textWidth(c, "0")+2*(p.PadX+p.EdgeW)).Height(p.Height).Padding(p.PadY, p.PadX, p.PadY, p.PadX).
		Border(p.EdgeW, p.Edge).Radius(p.Radius).Background(p.Background).TextColor(p.Fg).PlaceholderColor(p.Placeholder).FontSize(p.Size)
}

// drawSelect draws a select as wide as its longest option, and reports that the value changed.
func (p PlainControls) drawSelect(c *ui.Context, binder *Binder, name, label string, value *string, options []string) bool {
	var longest float32
	for _, option := range options {
		longest = max(longest, p.textWidth(c, option))
	}
	selector := ui.SelectBase(c, value)
	binder.Bound(selector.Trigger, name)
	selector.Trigger.Width(longest+p.SelectRoom).Height(p.SelectH).Row().AlignItems(ui.Center).Padding(0, 0, 0, p.SelectPad).
		Radius(p.SelectRadius).Border(p.Halo, p.Background).Background(p.SelectFill).Label(label).Children(func() {
		ui.Text(c, *value).FontSize(p.Size).TextColor(p.Fg).Font(p.Font).NoWrap().Grow(1)
		if p.Arrows != nil {
			ui.Icon(c, p.Arrows).Size(p.Size, p.Size).TextColor(p.Fg).MarginEnd(p.PadX)
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
				item.Children(func() { ui.Text(c, option).FontSize(p.Size).TextColor(p.Fg) })
			}
		})
	})
	return selector.Trigger.Changed()
}
