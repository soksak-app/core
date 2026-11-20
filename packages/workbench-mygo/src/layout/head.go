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
	// ToolsWidth is the width of the tools, MoreWidth is the width of the ⋯ button that holds them in the menu stage, and KeptWidth is
	// the width of the tools that the menu stage keeps beside ⋯ with their gaps: the fullscreen toggle and the leader mark.
	ToolsWidth float64 `json:"toolsWidth"`
	MoreWidth  float64 `json:"moreWidth"`
	KeptWidth  float64 `json:"keptWidth"`
	// TabWidths are the widths of the tabs and TabGap is the gap between them. The stage takes the widest tab in place of the active
	// tab, so it is the same whichever tab is active (docs/spec/example-model.md#card-tabs).
	TabWidths []float64 `json:"tabWidths"`
	TabGap    float64   `json:"tabGap"`
	// Peek is the chrome metric tab-peek-w: the spare width beside the active tab that keeps every tab. MinTab is the chrome metric
	// tab-min-w: the width under which the kept tools fold into the menu. Grab is the chrome metric tab-grab-w: the width under which
	// the active tab drops, the part of a tab that a press grabs to drag it.
	Peek   float64 `json:"peek"`
	MinTab float64 `json:"minTab"`
	Grab   float64 `json:"grab"`
}

// HeadFit is the stage of a card head: Fit is strip (every tab), one (the active tab) or ham (no tab), and Tools is bar, menu (⋯ with the
// kept tools beside it) or all (⋯ alone).
type HeadFit struct {
	Fit   string `json:"fit"`
	Tools string `json:"tools"`
}

// FitHead returns the stage of a card head. The head folds in this order: the other tabs, the tools into the ⋯ menu beside the kept
// tools down to the minimum width of the title, the kept tools into the menu down to the grab width of the title, then the title. The
// first stage whose condition holds is used.
func FitHead(head Head) HeadFit {
	inner := head.Width - head.PaddingLeft - head.PaddingRight - (head.Lead + head.Gap)
	whole, widest := 0.0, 0.0
	for _, w := range head.TabWidths {
		whole += w
		widest = math.Max(widest, w)
	}
	// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
	whole += float64(float64(max(0, len(head.TabWidths)-1)) * head.TabGap)
	withTools := inner - head.ToolsWidth - head.Gap
	withKept := inner - head.MoreWidth - head.KeptWidth - head.Gap
	withMore := inner - head.MoreWidth - head.Gap
	switch {
	case withTools >= math.Min(whole, widest+head.Peek):
		return HeadFit{Fit: "strip", Tools: "bar"}
	case withTools >= widest:
		return HeadFit{Fit: "one", Tools: "bar"}
	case withKept >= math.Min(widest, head.MinTab):
		return HeadFit{Fit: "one", Tools: "menu"}
	case withMore >= math.Min(widest, head.Grab):
		return HeadFit{Fit: "one", Tools: "all"}
	}
	return HeadFit{Fit: "ham", Tools: "all"}
}
