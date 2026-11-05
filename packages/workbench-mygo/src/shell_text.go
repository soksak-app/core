package workbench

import (
	"encoding/json"
	"fmt"
	"math"

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

// chromeHeight is the height of the first row, which grows with the frame factor (docs/spec/text-size.md#rendering).
func (s *Shell) chromeHeight() float32 {
	return float32(math.Round(max(1, s.text.Frame()) * float64(s.metrics.chromeH)))
}

// frameFont is the size of a text of the frame chrome.
func (s *Shell) frameFont(size float32) float32 { return size * float32(s.text.Frame()) }

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
}

// stripTarget is where a strip centres its active tab.
type stripTarget struct {
	tab string
	to  float64
}
