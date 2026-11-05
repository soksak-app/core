package workbench

import (
	"encoding/json"

	"github.com/egoist/mygo/ui"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The value of core.verify for the plane of the window. A frame ends with a verification of what it drew, as a render of the page
// workbench does. The rows read the element tree of the frame and the answer of the host, so a row states what happened and not
// what the workbench asked for.

// verifyLater runs the verification in the step after the frame, because the element tree of a frame is not readable while the
// frame builds. A frame that follows before the step ran is verified by that step.
func (s *Shell) verifyLater() {
	if s.verifying {
		return
	}
	s.verifying = true
	s.options.Post(func() {
		s.verifying = false
		if err := s.verification.Update(s.surfaces.planeDrawn, s.verifyPlane, s.surfaces.failure); err != nil {
			s.fail(err)
		}
	})
}

// verifyPlane runs the verification of the drawn plane.
func (s *Shell) verifyPlane() ([]VerifyRow, error) {
	window, err := s.options.Window()
	if err != nil {
		return nil, err
	}
	tree, err := s.options.Elements.ElementTree()
	if err != nil {
		return nil, err
	}
	origin := s.planeOrigin()
	drawn := make(map[string]DrawnSurface, len(s.surfaces.drawn))
	for id, box := range s.surfaces.drawn {
		held := s.surfaces.held[id]
		slot := DrawnSurface{Frame: inPlane(box, origin), Dim: s.surfaceDimmed(id), Predicted: true, Card: s.cardOfTab(id)}
		if held != nil && held.section != nil {
			slot.Predicted = false
			slot.Card = sectionCard(held.section)
		}
		drawn[id] = slot
	}
	edge := float64(s.palette.BorderWidth)
	head, foot := float64(s.metrics.headH), float64(s.metrics.footH)
	in := VerifyInput{
		Grid: s.plane,
		Tabs: func(id string) int {
			card, ok := s.plane.Card(id)
			if !ok {
				return 0
			}
			data, err := s.readCard(card)
			if err != nil || data == nil {
				return 0
			}
			return len(data.TabList())
		},
		Scale:      window.Scale,
		CardRadius: float64(s.palette.Radius),
		Latest:     s.surfaces.latest,
		Seated:     s.surfaces.answered,
		Pending:    s.surfaces.latest != nil && (s.surfaces.answered == nil || s.surfaces.latest.Seq > s.surfaces.answered.Seq),
		Drawn:      drawn,
		Cards:      DrawnCards(tree, layout.Rect{X: origin.X, Y: origin.Y}),
		Plane:      layout.Rect{W: s.plane.Width(), H: s.plane.Height()},
		Pad:        float64(s.stageInset()),
		Rules:      s.drawnRules(),
		Band:       DropBand{HeaderPx: head + edge, FooterPx: foot + edge},
		Head:       head,
		Foot:       foot,
		Chrome:     DrawnChrome(tree),
		Controls:   s.surfaces.controls,
		Bar:        layout.Rect{W: window.Width, H: float64(s.chromeHeight())},
	}
	for _, group := range s.railGroups() {
		in.Outline = group.Outline
		in.RailGroups = append(in.RailGroups, group.Rects)
	}
	return Verify(in)
}

// sectionCard is the card that holds a section surface: the card that the section belongs to, or its window sidebar.
func sectionCard(section *sectionStart) string {
	if section.Card != nil {
		return *section.Card
	}
	return section.Sidebar
}

// inPlane returns the rectangle of the window in the coordinates of the plane at origin.
func inPlane(box layout.Rect, origin layout.Point) layout.Rect {
	return layout.Rect{X: box.X - origin.X, Y: box.Y - origin.Y, W: box.W, H: box.H}
}

// drawnRules returns the lines that drawRules draws, in the coordinates of the plane.
func (s *Shell) drawnRules() []layout.Rect {
	place, _ := s.settings.Value("fullRule").(string)
	inset := s.stageInset()
	rules := []layout.Rect{}
	for _, rule := range s.plane.Rules() {
		if rule.Virtual && place == "none" {
			continue
		}
		r := ruleRect(rule, s.plane.Width(), s.plane.Height(), ui.Rect{X: -inset, Y: -inset}, inset)
		rules = append(rules, layout.Rect{X: float64(r.X), Y: float64(r.Y), W: float64(r.W), H: float64(r.H)})
	}
	return rules
}

// surfaceRecord returns the record of a placement: the surfaces that the frame seats, where the frame declared them.
func (s *Shell) surfaceRecord(lines []surfaceLine, settled bool) *VerifyRecord {
	s.surfaces.sequence++
	origin := s.planeOrigin()
	record := &VerifyRecord{Seq: s.surfaces.sequence, Settled: settled, Surfaces: []VerifySurface{}}
	for _, line := range lines {
		if line.visible {
			record.Surfaces = append(record.Surfaces, VerifySurface{ID: line.held.tab.ID, Declared: inPlane(line.box, origin), Visible: true, Dim: line.dim})
		}
	}
	return record
}

// seatRecord fills the record with the answer of the host. A visible surface that the answer does not name stays at the empty
// rectangle, which the rows report as a surface that the host did not apply where it was declared.
func (s *Shell) seatRecord(record *VerifyRecord, answer any) error {
	placements, err := decode[[]struct {
		ID      string  `json:"id"`
		X       float64 `json:"x"`
		Y       float64 `json:"y"`
		W       float64 `json:"w"`
		H       float64 `json:"h"`
		Visible bool    `json:"visible"`
	}](answer)
	if err != nil {
		return err
	}
	origin := s.planeOrigin()
	clear(s.surfaces.applied)
	for _, placement := range placements {
		if !placement.Visible {
			for index := range record.Surfaces {
				if record.Surfaces[index].ID == placement.ID {
					record.Surfaces[index].Visible = false
				}
			}
			continue
		}
		box := layout.Rect{X: placement.X, Y: placement.Y, W: placement.W, H: placement.H}
		s.surfaces.applied[placement.ID] = box
		for index := range record.Surfaces {
			if record.Surfaces[index].ID == placement.ID {
				record.Surfaces[index].Applied = inPlane(box, origin)
			}
		}
	}
	s.surfaces.answered = record
	return nil
}

// followChrome keeps the area of the window buttons that a preparation answers.
func (s *Shell) followChrome(chrome json.RawMessage) error {
	if len(chrome) == 0 {
		return nil
	}
	var read struct {
		Controls layout.Rect `json:"controls"`
	}
	if err := json.Unmarshal(chrome, &read); err != nil {
		return err
	}
	s.surfaces.controls = &read.Controls
	return nil
}
