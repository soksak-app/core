package workbench_test

import (
	"image"
	"math"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// stem is what the strokes of a drawn text measure: ink counts the pixels nearer the text color than the background, and width is
// the mean length of their horizontal runs, the width of a vertical stem.
type stem struct {
	ink   int
	width float64
}

// measureStem measures the strokes of the text in the box of the window's DIPs, against the color of its corner.
func measureStem(img *image.RGBA, box ui.Rect, scale float32) stem {
	x0, y0 := int(box.X*scale), int(box.Y*scale)
	x1, y1 := int((box.X+box.W)*scale), int((box.Y+box.H)*scale)
	lum := func(x, y int) float64 {
		p := img.RGBAAt(x, y)
		return 0.2126*float64(p.R) + 0.7152*float64(p.G) + 0.0722*float64(p.B)
	}
	bg := lum(x0, y0)
	far := 0.0
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			far = math.Max(far, math.Abs(lum(x, y)-bg))
		}
	}
	var s stem
	runs, total := 0, 0
	for y := y0; y < y1; y++ {
		run := 0
		for x := x0; x <= x1; x++ {
			if x < x1 && math.Abs(lum(x, y)-bg) > far/2 {
				run++
				s.ink++
				continue
			}
			if run > 0 {
				runs++
				total += run
				run = 0
			}
		}
	}
	if runs > 0 {
		s.width = float64(total) / float64(runs)
	}
	return s
}

// referenceStem draws the text alone in a family and weight at the header's size, in the header's colors: the coverage of a glyph
// edge reads differently dark on light than light on dark.
func referenceStem(t *testing.T, text, family string, weight int, fg, bg ui.Color) stem {
	t.Helper()
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Box(c).Size(240, 60).Background(bg).Children(func() {
			ui.Text(c, text).NoWrap().Font(family).FontWeight(weight).FontSize(sidebarMetrics.SectionHeadText).TextColor(fg)
		})
	}, 240, 60)
	box, ok := tt.Find(text)
	if !ok {
		t.Fatalf("no text %q in the reference; the texts are %q", text, tt.Texts())
	}
	return measureStem(tt.Image(), box, float32(tt.Image().Bounds().Dx())/240)
}

// The name of a section has the strokes of the page's header, weight 600 of the system font, whatever font the settings choose:
// the page draws `.set__head` as `font: 600 var(--section-head-text) var(--ui-font)`.
func TestTheNameOfASectionHasTheStemsOfThePageHeader(t *testing.T) {
	for _, name := range []string{"파일 트리", "Files"} {
		t.Run(name, func(t *testing.T) {
			var calls []call
			frame := listFrame()
			frame.Sections[0].Name = name
			binder := recorder(t, &calls, sidebarCommands...)
			var theme *ui.Theme
			tt := ui.NewTester(func(c *ui.Context) {
				theme = c.Theme()
				// A font the settings choose, which the header of the page does not follow.
				ui.Box(c).Size(240, 400).Font("monospace").Children(func() {
					workbench.DrawSidebar(c, binder, &workbench.SectionDrag{}, frame, sidebarMetrics, 240, 400, func(*ui.Context, workbench.SidebarSeat) {})
				})
			}, 240, 400)
			box, ok := tt.Find(name)
			if !ok {
				t.Fatalf("no section name %q; the texts are %q", name, tt.Texts())
			}
			scale := float32(tt.Image().Bounds().Dx()) / 240
			got := measureStem(tt.Image(), box, scale)
			corner := tt.Image().RGBAAt(int(box.X*scale), int(box.Y*scale))
			fg, bg := theme.Text, ui.RGB(corner.R, corner.G, corner.B)
			want := referenceStem(t, name, "system-ui", 600, fg, bg)
			bold := referenceStem(t, name, "system-ui", 700, fg, bg)
			mono := referenceStem(t, name, "monospace", 700, fg, bg)
			if math.Abs(float64(got.ink)/float64(want.ink)-1) > 0.02 || math.Abs(got.width-want.width) > 0.15 {
				t.Fatalf("the name has ink %d and stems %.2f px wide, want ink %d and stems %.2f px of system-ui 600 (system-ui 700: %d, %.2f; monospace 700: %d, %.2f)",
					got.ink, got.width, want.ink, want.width, bold.ink, bold.width, mono.ink, mono.width)
			}
		})
	}
}
