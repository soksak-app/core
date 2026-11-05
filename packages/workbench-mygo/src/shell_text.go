package workbench

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// shellText is the place of the text size of a window (docs/spec/text-size.md): the common setting of the workspace and the layout data
// of the cards of the plane.
type shellText struct{ s *Shell }

func (t shellText) FocusedCard() string {
	if t.s.plane == nil || t.s.browsing {
		return ""
	}
	return t.s.focused
}

// placeInput is the observer of a place: a press anywhere in it makes the place of scope the scope of the text size.
func (s *Shell) placeInput(scope TextScope) func(ui.InputEvent) {
	return func(ev ui.InputEvent) {
		if ev.Kind == ui.InputPointerDown {
			s.pressPlace(scope)
		}
	}
}

// pressPlace records a press on the place of scope. A watcher of the status core.text sees it in the next frame.
func (s *Shell) pressPlace(scope TextScope) {
	if err := s.text.Press(scope); err != nil {
		s.fail(err)
		return
	}
	s.options.Invalidate()
}

func (t shellText) FrameTextSize() float64 { return t.s.settings.Value("textSize").(float64) }

func (t shellText) SetFrameTextSize(size float64, actor string) error {
	if err := t.s.settingsChange(actor, func() error { return t.s.settings.Set(map[string]any{"textSize": size}, "common") }); err != nil {
		return err
	}
	t.s.followScale()
	t.s.options.Invalidate()
	return nil
}

func (t shellText) CardTextSizes() map[string]float64 {
	sizes := map[string]float64{}
	if t.s.plane == nil {
		return sizes
	}
	for _, card := range t.s.plane.Cards() {
		sizes[card.ID] = 1
		data, err := t.s.readCard(card)
		if err != nil {
			t.s.fail(fmt.Errorf("the data of card %s: %w", card.ID, err))
			continue
		}
		if data != nil && data.TextSize != nil {
			sizes[card.ID] = *data.TextSize
		}
	}
	return sizes
}

func (t shellText) SetCardTextSize(id string, size float64) error {
	card, ok := t.s.plane.Card(id)
	if !ok {
		return fmt.Errorf("text size card %s is not in the layout", id)
	}
	data, err := layout.DecodeCardData(card.Data)
	if err != nil {
		return err
	}
	if data == nil {
		data = &layout.CardData{}
	}
	data.TextSize = &size
	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}
	t.s.plane.SetData(id, encoded)
	t.s.settle()
	t.s.followScale()
	return nil
}

// chromeHeight is the height of the first row, chromeRow of packages/workbench/frame-text.js (docs/spec/text-size.md#rendering).
func (s *Shell) chromeHeight() float32 {
	return float32(math.Round(math.Max(float64(s.metrics.chromeH), s.text.Frame()*float64(s.metrics.chromeRowH))))
}

// spaceRowHeight is the height of the row of the spaces, which grows with the frame factor and stays on whole pixels.
func (s *Shell) spaceRowHeight() float32 {
	return float32(math.Round(s.text.Frame() * float64(s.metrics.chromeRowH)))
}

// frameFont is the size of a text of the frame chrome.
func (s *Shell) frameFont(size float32) float32 { return size * float32(s.text.Frame()) }

// frameLength is a length of the frame chrome, which grows with its text.
func (s *Shell) frameLength(length float32) float32 { return length * float32(s.text.Frame()) }

// textControl is the size of the text of a control of the bars at the size setting.
func (s *Shell) textControl() float32 {
	return float32(s.settings.Value("size").(float64)) * s.metrics.textControlAtBase / s.metrics.textBase
}

// textCaption is the size of a caption at the size setting.
func (s *Shell) textCaption() float32 {
	return float32(s.settings.Value("size").(float64)) * s.metrics.textCaptionAtBase / s.metrics.textBase
}

// chromePercent is the chrome value name, a percentage, as a share.
func (s *Shell) chromePercent(name string) float32 {
	text, _ := s.options.Declared.ChromeText(name)
	value, _ := strconv.ParseFloat(strings.TrimSuffix(text, "%"), 32)
	return float32(value) / 100
}

// chLength is the chrome value name, a number of ch, at the font size: a figure of a form font is about .6 of its size wide.
func (s *Shell) chLength(name string, size float32) float32 {
	text, _ := s.options.Declared.ChromeText(name)
	value, _ := strconv.ParseFloat(strings.TrimSuffix(text, "ch"), 32)
	return float32(value) * size * .6
}

// sectionTracking is the chrome value section-tracking, the spacing of a section name as a share of its font size.
func (s *Shell) sectionTracking() float32 {
	text, _ := s.options.Declared.ChromeText("section-tracking")
	value, _ := strconv.ParseFloat(strings.TrimSuffix(text, "em"), 32)
	return float32(value)
}

// textSmall is the size of the small text of a card head, the proportion of the size setting that the page states.
func (s *Shell) textSmall() float32 {
	return float32(s.settings.Value("size").(float64)) * s.metrics.textSmallAtBase / s.metrics.textBase
}

// fontFamily is the font stack of the font setting.
func (s *Shell) fontFamily() string {
	return s.settings.Catalog.Stack(s.settings.Value("font").(string))
}

// stripPlace is the scroll of a tab strip and the target it was last given.
type stripPlace struct {
	state  *ui.ScrollState
	target stripTarget
	drawn  bool
	// aim is whether the next frame takes the glide to the target again.
	aim bool
}

// stripTarget is where a strip centres its active tab.
type stripTarget struct {
	tab string
	to  float64
}
