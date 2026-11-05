package workbench

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The drag of a tab, as beginTabDrag of packages/workbench/plane.js handles it: a press selects the tab, a press that moved takes the zone of the
// plane under the pointer, and the release runs core.tab.move. The result of a drop is that of dropTab.

// tabDragThreshold is how far a press moves before it is a drag, in points.
const tabDragThreshold = 4

// tabZones are the zones of the drop on a card.
var tabZones = []string{"centre", "left", "right", "top", "bottom"}

// tabDrag is the drag in progress. hit and preview are the drop that the release would run, in the coordinates of the plane.
type tabDrag struct {
	card, tab string
	x, y      float32
	moved     bool
	hit       *layout.ZoneHit
	preview   *layout.Rect
}

type tabMoveParam struct {
	Tab  string `json:"tab"`
	Card string `json:"card"`
	Zone string `json:"zone"`
}

// dragTarget is the drop target of the status core.drag.
type dragTarget struct {
	Card string `json:"card"`
	Zone string `json:"zone"`
}

// dragStatus is the status core.drag.
type dragStatus struct {
	Tab     string       `json:"tab"`
	Card    string       `json:"card"`
	Moved   bool         `json:"moved"`
	Target  *dragTarget  `json:"target"`
	Preview *layout.Rect `json:"preview"`
}

// registerTabDrag adds the command and the status of the drag.
func (s *Shell) registerTabDrag() {
	s.registry.Status("core.drag", func() any {
		drag := s.dragging
		if drag == nil {
			return nil
		}
		status := dragStatus{Tab: drag.tab, Card: drag.card, Moved: drag.moved, Preview: drag.preview}
		if drag.hit != nil {
			status.Target = &dragTarget{Card: drag.hit.ID, Zone: drag.hit.Zone}
		}
		return status
	})
	act(s, "core.tab.move", func(value tabMoveParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.moveTab(value.Tab, value.Card, value.Zone)
	})
}

// tabInput handles the pointer on the name of a tab. The position of an event is relative to the element, which stands at bounds until the next
// frame, so adding them gives the position in the window. It leaves a press that did not move to the button of the tab.
func (s *Shell) tabInput(card, tab string, bounds ui.Rect) func(ui.InputEvent) bool {
	return func(event ui.InputEvent) bool {
		x, y := bounds.X+event.X, bounds.Y+event.Y
		switch event.Kind {
		case ui.InputPointerDown:
			if event.Button != 0 {
				return false
			}
			s.dragging = &tabDrag{card: card, tab: tab, x: x, y: y}
			s.binder.run("core.tab.select", tabParam{tab})
			return false
		case ui.InputPointerMove:
			drag := s.dragging
			if drag == nil || drag.tab != tab {
				return false
			}
			s.dragTabTo(drag, x, y)
			s.options.Invalidate()
			return true
		case ui.InputPointerUp:
			drag := s.dragging
			if drag == nil || drag.tab != tab {
				return false
			}
			s.dragging = nil
			s.options.Invalidate()
			if !drag.moved {
				return false
			}
			if drag.hit != nil {
				s.binder.run("core.tab.move", tabMoveParam{Tab: drag.tab, Card: drag.hit.ID, Zone: drag.hit.Zone})
			} else {
				s.settle()
			}
			return true
		}
		return false
	}
}

// dragTabTo follows the pointer. Only a press that moved is a drag, and it releases the full screen, since the drop zones are the cards of the
// ordinary layout. A drop that the layout refuses has no zone.
func (s *Shell) dragTabTo(drag *tabDrag, x, y float32) {
	if !drag.moved && math.Hypot(float64(x-drag.x), float64(y-drag.y)) <= tabDragThreshold {
		return
	}
	drag.moved = true
	s.fullscreen = ""
	origin := s.planeOrigin()
	edge := float64(s.palette.BorderWidth)
	header, footer := float64(s.metrics.headH)+edge, float64(s.metrics.footH)+edge
	options := layout.ZoneOptions{HeaderPx: &header, FooterPx: &footer}
	data, err := s.cardData(drag.card)
	if err != nil {
		s.fail(err)
		return
	}
	if len(data.TabList()) == 1 {
		options.CentreOnly = &drag.card
	}
	drag.hit, drag.preview = s.plane.ZoneAt(float64(x)-origin.X, float64(y)-origin.Y, options), nil
	if drag.hit != nil && !isPlace(drag.hit.ID) {
		drag.preview = s.dropRect(drag.card, drag.hit)
	}
	if drag.preview == nil {
		drag.hit = nil
	}
}

// dropRect is the rectangle of the card that a drop produces, and nil when the layout refuses the drop. The drop runs on a copy of the plane, since
// a cut shares the gap between its two pieces and a move closes before it cuts, so half of the target is not where the card lands.
func (s *Shell) dropRect(from string, hit *layout.ZoneHit) *layout.Rect {
	state := s.plane.ToJSON()
	gap, minimum, width, height := s.plane.Gap(), s.plane.MinSize(), s.plane.Width(), s.plane.Height()
	plane, err := layout.New(&state, layout.Options{Gap: &gap, MinSize: &minimum, Width: &width, Height: &height})
	if err != nil {
		s.fail(fmt.Errorf("the copy of the plane: %w", err))
		return nil
	}
	id := hit.ID
	if hit.Zone != "centre" {
		data, err := s.cardData(from)
		if err != nil {
			s.fail(err)
			return nil
		}
		if len(data.TabList()) == 1 {
			if !plane.Move(from, hit.ID, hit.Zone) {
				return nil
			}
			id = from
		} else {
			born, ok := plane.SplitToward(hit.ID, hit.Zone, layout.SplitInit{})
			if !ok {
				return nil
			}
			id = born
		}
	}
	rect, ok := plane.Rect(id)
	if !ok {
		return nil
	}
	return &rect
}

// moveTab moves a tab to the centre or an edge of a card, as a drop does.
func (s *Shell) moveTab(tab, card, zone string) error {
	from := s.cardOfTab(tab)
	if from == "" {
		return fmt.Errorf("Unknown tab: %s", tab)
	}
	if err := s.paneCard(card); err != nil {
		return err
	}
	if !slices.Contains(tabZones, zone) {
		return fmt.Errorf("unknown zone %s", zone)
	}
	hit := &layout.ZoneHit{ID: card, Zone: zone}
	if zone != "centre" && s.dropRect(from, hit) == nil {
		return fmt.Errorf("tab %s cannot move to the %s of %s", tab, zone, card)
	}
	s.fullscreen = ""
	return s.dropTab(from, tab, hit)
}

// dropTab runs a drop. A drop on the centre moves the tab into the card, and a drop on an edge moves the whole card when it holds only this tab, so
// no empty card remains, and otherwise cuts a new card for the tab.
func (s *Shell) dropTab(from, tab string, hit *layout.ZoneHit) error {
	source, err := s.cardData(from)
	if err != nil {
		return err
	}
	index := slices.IndexFunc(source.TabList(), func(held layout.Tab) bool { return held.ID == tab })
	if index < 0 {
		s.settle()
		return nil
	}
	moving := source.TabList()[index]
	if hit.Zone == "centre" {
		return s.dropOnCentre(from, source, moving, hit.ID)
	}
	if len(source.TabList()) == 1 {
		if from != hit.ID {
			s.plane.Move(from, hit.ID, hit.Zone)
			s.focusCard(from)
		}
		s.settle()
		return nil
	}
	encoded, err := json.Marshal(tabData([]layout.Tab{moving}, moving.ID))
	if err != nil {
		return err
	}
	born, ok := s.plane.SplitToward(hit.ID, hit.Zone, layout.SplitInit{Data: encoded})
	if ok {
		source.RemoveTab(tab)
		source.SettleActiveTab()
		if err := s.storeCard(from, source); err != nil {
			return err
		}
		s.focusCard(born)
	}
	s.settle()
	return nil
}

func (s *Shell) dropOnCentre(from string, source *layout.CardData, moving layout.Tab, card string) error {
	if card == from {
		source.SelectTab(moving.ID)
		if err := s.storeCard(from, source); err != nil {
			return err
		}
		s.settle()
		return nil
	}
	target, err := s.cardData(card)
	if err != nil {
		return err
	}
	source.RemoveTab(moving.ID)
	target.AppendTab(moving)
	if err := s.storeCard(card, target); err != nil {
		return err
	}
	s.focusCard(card)
	if len(source.TabList()) == 0 && s.plane.CanClose(from) {
		s.plane.Close(from)
		delete(s.operated, from)
	} else {
		source.SettleActiveTab()
		if err := s.storeCard(from, source); err != nil {
			return err
		}
	}
	s.settle()
	return nil
}

// drawDropPreview draws where the drop lands, over the cards of the stage.
func (s *Shell) drawDropPreview(c *ui.Context, inset float32) {
	if s.dragging == nil || s.dragging.preview == nil {
		return
	}
	rect := s.dragging.preview
	ui.Box(s.binder.Name(c, "core.drop", "")).Role(ui.RoleGroup).Label("놓을 자리").Absolute().Left(float32(rect.X)+inset).Top(float32(rect.Y)+inset).Size(float32(rect.W), float32(rect.H)).Radius(s.palette.Radius).
		Background(faded(s.palette.Focus, s.metrics.dropMix)).Border(s.metrics.dropBorder, s.palette.Focus)
}
