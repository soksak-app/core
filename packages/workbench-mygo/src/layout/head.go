package layout

import "math"

// The fold stage of a card head (docs/spec/example-model.md#card-tabs), as packages/workbench/head-fit.js decides it. The shared
// layout cases of docs/spec/cases/layout/head.json state it, so both workbenches fold a head at the same widths.

// Head is the measured widths of a card head and the two chrome metrics that bound its stages.
type Head struct {
	// Width is the width of the head, and PaddingLeft and PaddingRight are its padding.
	Width        float64 `json:"width"`
	PaddingLeft  float64 `json:"paddingLeft"`
	PaddingRight float64 `json:"paddingRight"`
	// Lead is the width of the button at the start of the head, and Gap is the gap between the elements of the head.
	Lead float64 `json:"lead"`
	Gap  float64 `json:"gap"`
	// ToolsWidth is the width of the tools, and MoreWidth is the width of the ⋯ button that holds them in the menu stage.
	ToolsWidth float64 `json:"toolsWidth"`
	MoreWidth  float64 `json:"moreWidth"`
	// TabWidths are the widths of the tabs, TabGap is the gap between them, and ActiveWidth is the width of the active tab, 0 without one.
	TabWidths   []float64 `json:"tabWidths"`
	TabGap      float64   `json:"tabGap"`
	ActiveWidth float64   `json:"activeWidth"`
	// Peek is the chrome metric tab-peek-w: the spare width beside the active tab that keeps every tab. MinTab is the chrome metric
	// tab-min-w: the width under which the active tab drops.
	Peek   float64 `json:"peek"`
	MinTab float64 `json:"minTab"`
}

// HeadFit is the stage of a card head: Fit is strip (every tab), one (the active tab) or ham (no tab), and Tools is bar or menu.
type HeadFit struct {
	Fit   string `json:"fit"`
	Tools string `json:"tools"`
}

// FitHead returns the stage of a card head. The head folds in this order: the other tabs, the tools (into the ⋯ menu) down to the
// minimum width of the title, then the title. The first stage whose condition holds is used.
func FitHead(head Head) HeadFit {
	inner := head.Width - head.PaddingLeft - head.PaddingRight - (head.Lead + head.Gap)
	whole := 0.0
	for _, w := range head.TabWidths {
		whole += w
	}
	// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
	whole += float64(float64(max(0, len(head.TabWidths)-1)) * head.TabGap)
	withTools := inner - head.ToolsWidth - head.Gap
	withMenu := inner - head.MoreWidth - head.Gap
	switch {
	case withTools >= math.Min(whole, head.ActiveWidth+head.Peek):
		return HeadFit{Fit: "strip", Tools: "bar"}
	case withTools >= head.ActiveWidth:
		return HeadFit{Fit: "one", Tools: "bar"}
	case withMenu >= math.Min(head.ActiveWidth, head.MinTab):
		return HeadFit{Fit: "one", Tools: "menu"}
	}
	return HeadFit{Fit: "ham", Tools: "menu"}
}
