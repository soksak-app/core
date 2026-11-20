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

// tabDrag is the drag in progress: of a tab, or of the group card card by its header while tab is empty. hit and preview are the drop
// that the release would run, in the coordinates of the plane.
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
		if !s.drawnPlaneShown() {
			return false
		}
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
	edge := float64(s.palette.CardBorder())
	header, footer := float64(s.metrics.headH)+edge, float64(s.metrics.footH)+edge
	options := layout.ZoneOptions{HeaderPx: &header, FooterPx: &footer}
	if drag.tab == "" {
		s.dragGroupTo(drag, float64(x)-origin.X, float64(y)-origin.Y, options)
		return
	}
	data, err := s.cardData(drag.card)
	if err != nil {
		s.fail(err)
		return
	}
	if len(data.TabList()) == 1 {
		options.CentreOnly = &drag.card
	}
	// The drop resolves on the innermost box under the point, a content card before the group card that holds it.
	drag.hit, drag.preview = s.planes.DropAt(float64(x)-origin.X, float64(y)-origin.Y, options, ""), nil
	if drag.hit != nil && !isPlace(drag.hit.ID) {
		drag.preview = s.dropRect(drag.card, drag.hit)
	}
	if drag.preview == nil {
		drag.hit = nil
	}
}

// dropRect is the rectangle of the card that a drop produces, in the coordinates of the plane, and nil when the layout refuses the
// drop. The drop runs on the tree and the tree is put back, since a cut shares the gap between its two pieces and a move closes before
// it cuts, so half of the target is not where the card lands.
func (s *Shell) dropRect(from string, hit *layout.ZoneHit) *layout.Rect {
	var rect *layout.Rect
	err := s.planes.Probe(func() error {
		id, err := s.dropCard(from, hit, json.RawMessage(`{}`))
		if err != nil {
			return err
		}
		if placed, ok := s.planes.Rect(id); ok {
			rect = &placed
		}
		return nil
	})
	if err != nil {
		return nil
	}
	return rect
}

// dropCard makes the change of the layout of a drop of a tab of the card from on hit and returns the card that holds the tab after it:
// a tab that is the only tab of its card moves its card, which cannot move beside itself, the centre of a group card takes a new card with data at the right edge of
// its rectangle, the centre of a content card changes no card, and a side takes a new card with data beside the target
// (docs/spec/groups.md#moving-and-dropping).
func (s *Shell) dropCard(from string, hit *layout.ZoneHit, data json.RawMessage) (string, error) {
	source, err := s.cardData(from)
	if err != nil {
		return "", err
	}
	single := len(source.TabList()) == 1
	switch {
	case hit.Zone == "centre" && !s.isGroup(hit.ID):
		return hit.ID, nil
	case single && from == hit.ID:
		return "", fmt.Errorf("card %s cannot move beside itself", from)
	case single:
		if !s.planes.Moved(from, hit.ID, hit.Zone) {
			if err := s.planes.Move(from, hit.ID, hit.Zone); err != nil {
				return "", err
			}
		}
		return from, nil
	case hit.Zone == "centre":
		return s.planes.AddCard(hit.ID, data)
	}
	return s.planes.Split(hit.ID, hit.Zone, data)
}

// moveTab moves a tab to the centre or an edge of a card, as a drop does.
func (s *Shell) moveTab(tab, card, zone string) error {
	from := s.cardOfTab(tab)
	if from == "" {
		return fmt.Errorf("no tab %s", tab)
	}
	if err := s.paneCard(card); err != nil {
		return err
	}
	if !slices.Contains(tabZones, zone) {
		return fmt.Errorf("unknown zone %s", zone)
	}
	hit := &layout.ZoneHit{ID: card, Zone: zone}
	if (zone != "centre" || s.isGroup(card)) && s.dropRect(from, hit) == nil {
		return fmt.Errorf("tab %s cannot move to the %s of %s", tab, zone, card)
	}
	s.fullscreen = ""
	return s.dropTab(from, tab, hit)
}

// dropTab runs a drop. A drop on the centre of a content card moves the tab into the card, a drop of the only tab of a card moves the
// card, so no empty card remains, and a drop on a side or on the centre of a group card puts the tab into a new card (dropCard).
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
	if hit.Zone == "centre" && !s.isGroup(hit.ID) {
		return s.dropOnCentre(from, source, moving, hit.ID)
	}
	encoded, err := json.Marshal(tabData([]layout.Tab{moving}, moving.ID))
	if err != nil {
		return err
	}
	single := len(source.TabList()) == 1
	holder, err := s.dropCard(from, hit, encoded)
	if err != nil {
		return err
	}
	if !single {
		source.RemoveTab(tab)
		source.SettleActiveTab()
		if err := s.storeCard(from, source); err != nil {
			return err
		}
	}
	s.focusCard(holder)
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
	if len(source.TabList()) == 0 && s.planes.CanClose(from) {
		if _, err := s.planes.Close(from); err != nil {
			return err
		}
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
	// .drop: at the seam the preview has the shape of the seam, no radius and a border of the border width (the seam rules of
	// packages/workbench/app.css).
	border := s.metrics.dropBorder
	if s.palette.Seam() {
		border = s.palette.BorderWidth
	}
	ui.Box(s.binder.Name(c, "core.drop", "")).Role(ui.RoleGroup).Label("놓을 자리").Absolute().Left(float32(rect.X)+inset).Top(float32(rect.Y)+inset).Size(float32(rect.W), float32(rect.H)).Radius(s.palette.CardRadius()).
		Background(faded(s.palette.Focus, s.metrics.dropMix)).Border(border, s.palette.Focus)
}

// dragGroupTo takes the drop of the dragged group card at x and y of the plane: the resolution leaves out the group card and the cards
// inside it, and the drop is the move of core.card.move, which the tree refuses or places (docs/spec/groups.md#moving-and-dropping).
func (s *Shell) dragGroupTo(drag *tabDrag, x, y float64, options layout.ZoneOptions) {
	drag.hit, drag.preview = s.planes.DropAt(x, y, options, drag.card), nil
	if drag.hit != nil && !isPlace(drag.hit.ID) && s.planes.CheckMove(drag.card, drag.hit.ID, drag.hit.Zone) == nil {
		hit := drag.hit
		err := s.planes.Probe(func() error {
			if err := s.planes.Move(drag.card, hit.ID, hit.Zone); err != nil {
				return err
			}
			if placed, ok := s.planes.Rect(drag.card); ok {
				drag.preview = &placed
			}
			return nil
		})
		if err != nil {
			drag.preview = nil
		}
	}
	if drag.preview == nil {
		drag.hit = nil
	}
}

// groupHeadInput handles the pointer on the header of the group card id outside its buttons: a press that moves drags the group card,
// and the release runs core.card.move toward the drop, or changes nothing without one. bounds is where the header stands.
func (s *Shell) groupHeadInput(id string, bounds ui.Rect) func(ui.InputEvent) bool {
	return func(event ui.InputEvent) bool {
		if !s.drawnPlaneShown() {
			return false
		}
		x, y := bounds.X+event.X, bounds.Y+event.Y
		switch event.Kind {
		case ui.InputPointerDown:
			if event.Button != 0 || event.Clicks > 1 {
				return false
			}
			s.dragging = &tabDrag{card: id, x: x, y: y}
			return false
		case ui.InputPointerMove:
			drag := s.dragging
			if drag == nil || drag.tab != "" || drag.card != id {
				return false
			}
			s.dragTabTo(drag, x, y)
			s.options.Invalidate()
			return true
		case ui.InputPointerUp:
			drag := s.dragging
			if drag == nil || drag.tab != "" || drag.card != id {
				return false
			}
			s.dragging = nil
			s.options.Invalidate()
			if !drag.moved {
				return false
			}
			if drag.hit != nil {
				s.binder.run("core.card.move", cardMoveParam{Card: id, Target: drag.hit.ID, Side: drag.hit.Zone})
			} else {
				s.settle()
			}
			return true
		}
		return false
	}
}
