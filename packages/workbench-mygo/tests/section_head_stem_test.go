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

// sectionName is a section name as the sidebar draws it: its strokes, the box of the name element in the window's DIPs, and the
// colors it is drawn in, the text color of the theme on the header's background read at the corner of the box.
type sectionName struct {
	stem   stem
	box    ui.Rect
	fg, bg ui.Color
}

// drawnName draws a sidebar whose first section is named name, with the page's font stack for its names, and measures the name.
func drawnName(t *testing.T, name string) sectionName {
	t.Helper()
	var calls []call
	frame := listFrame()
	frame.Sections[0].Name = name
	binder := recorder(t, &calls, sidebarCommands...)
	metrics := sidebarMetrics
	metrics.SectionHeadFont = uiFont(t)
	var theme *ui.Theme
	tt := ui.NewTester(func(c *ui.Context) {
		theme = c.Theme()
		// A font the settings choose, which the header of the page does not follow.
		ui.Box(c).Size(240, 400).Font("monospace").Children(func() {
			workbench.DrawSidebar(c, binder, &workbench.SectionDrag{}, frame, metrics, 240, 400, func(*ui.Context, workbench.SidebarSeat) {})
		})
	}, 240, 400)
	// The name element alone: the header around it carries the name as its label and holds the chevron as well.
	box := element(t, tt, "core.sidebar.section.name", "left/"+frame.Sections[0].ID).Bounds
	scale := float32(tt.Image().Bounds().Dx()) / 240
	corner := tt.Image().RGBAAt(int(box.X*scale), int(box.Y*scale))
	return sectionName{stem: measureStem(tt.Image(), box, scale), box: box, fg: theme.Text, bg: ui.RGB(corner.R, corner.G, corner.B)}
}

// referenceStem draws the text alone in a family and weight at the header's size, in the colors and at the place of the drawn
// name: the coverage of a glyph edge reads differently dark on light than light on dark, and differently at another fraction of
// a pixel.
func referenceStem(t *testing.T, text, family string, weight int, at sectionName) stem {
	t.Helper()
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Box(c).Size(240, 400).Background(at.bg).Children(func() {
			ui.Text(c, text).SingleLine().Absolute().Left(at.box.X).Top(at.box.Y).Font(family).FontWeight(weight).
				FontSize(sidebarMetrics.SectionHeadText).TextColor(at.fg)
		})
	}, 240, 400)
	box, ok := tt.Find(text)
	if !ok {
		t.Fatalf("no text %q in the reference; the texts are %q", text, tt.Texts())
	}
	if box.X != at.box.X || box.Y != at.box.Y {
		t.Fatalf("the reference of %q stands at %+v, the drawn name at %+v", text, box, at.box)
	}
	// Both are measured over the box of the drawn name.
	return measureStem(tt.Image(), at.box, float32(tt.Image().Bounds().Dx())/240)
}

// The name of a section has the strokes of the page's header, weight 600 of the system font, whatever font the settings choose:
// the page draws `.set__head` as `font: 600 var(--section-head-text) var(--ui-font)`.
func TestTheNameOfASectionHasTheStemsOfThePageHeader(t *testing.T) {
	for _, name := range []string{"파일 트리", "Files"} {
		t.Run(name, func(t *testing.T) {
			drawn := drawnName(t, name)
			got := drawn.stem
			want := referenceStem(t, name, "system-ui", 600, drawn)
			bold := referenceStem(t, name, "system-ui", 700, drawn)
			mono := referenceStem(t, name, "monospace", 700, drawn)
			whole := drawn
			whole.box.X = float32(math.Floor(float64(drawn.box.X)))
			moved := referenceStem(t, name, "system-ui", 600, whole)
			t.Logf("%q drawn at %+v in %v on %v, size %.1f: ink %d stems %.2f; system-ui 600 there: ink %d stems %.2f; at x %.1f: ink %d stems %.2f",
				name, drawn.box, drawn.fg, drawn.bg, sidebarMetrics.SectionHeadText, got.ink, got.width, want.ink, want.width, whole.box.X, moved.ink, moved.width)
			if math.Abs(float64(got.ink)/float64(want.ink)-1) > 0.02 || math.Abs(got.width-want.width) > 0.15 {
				t.Fatalf("the name has ink %d and stems %.2f px wide, want ink %d and stems %.2f px of system-ui 600 (system-ui 700: %d, %.2f; monospace 700: %d, %.2f)",
					got.ink, got.width, want.ink, want.width, bold.ink, bold.width, mono.ink, mono.width)
			}
		})
	}
}

// The font stack of the page's header measures as the system font: -apple-system, its first family, is the system font of the
// page's browser, and the families after it only fill what the system font lacks.
func TestTheFontOfASectionNameIsTheSystemFont(t *testing.T) {
	stack := uiFont(t)
	for _, text := range []string{"파일 트리", "Files"} {
		drawn := drawnName(t, text)
		got := referenceStem(t, text, stack, 600, drawn)
		want := referenceStem(t, text, "system-ui", 600, drawn)
		t.Logf("%q at %+v: %s 600 ink %d stems %.2f; system-ui 600 ink %d stems %.2f", text, drawn.box, stack, got.ink, got.width, want.ink, want.width)
		if math.Abs(float64(got.ink)/float64(want.ink)-1) > 0.02 || math.Abs(got.width-want.width) > 0.15 {
			t.Errorf("%q in %s has ink %d and stems %.2f px, system-ui 600 ink %d and stems %.2f px", text, stack, got.ink, got.width, want.ink, want.width)
		}
	}
}

// uiFont is the font stack that the page's chrome declares for its own text.
func uiFont(t *testing.T) string {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	stack := declared.ChromeValue("ui-font")
	if stack == "" {
		t.Fatal("the chrome declares no ui-font")
	}
	return stack
}
