package workbench

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"

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
// that the release would run, in the coordinates of the plane, and anchor the band where the drag entered the line of its point.
type tabDrag struct {
	card, tab string
	x, y      float32
	moved     bool
	hit       *layout.DropTarget
	anchor    *layout.Anchor
	preview   *layout.Rect
}

type tabMoveParam struct {
	Tab  string        `json:"tab"`
	Card layout.Target `json:"card"`
	Zone string        `json:"zone"`
}

// dragTarget is the drop target of the status core.drag: a card, a box or the ids of the kids of a cut, and the zone of the drop there.
type dragTarget struct {
	Card layout.Target `json:"card"`
	Zone string        `json:"zone"`
}

// zoneOf is the target and the zone of a drop target: the side of an add, and the centre of a tab strip or of a content card.
func zoneOf(hit *layout.DropTarget) (layout.Target, string) {
	if hit.Kind == "add" {
		return hit.Target, hit.Side
	}
	return layout.Target{hit.Card}, "centre"
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
			card, zone := zoneOf(drag.hit)
			status.Target = &dragTarget{Card: card, Zone: zone}
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
				card, zone := zoneOf(drag.hit)
				s.binder.run("core.tab.move", tabMoveParam{Tab: drag.tab, Card: card, Zone: zone})
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
	options := s.targetOptions()
	if drag.tab == "" {
		s.dragGroupTo(drag, float64(x)-origin.X, float64(y)-origin.Y, options)
		return
	}
	// The drop resolves by the bands of the sides on the line of the point, from the outermost node in
	// (docs/spec/groups.md#target-search).
	drag.hit, drag.anchor = s.planes.DragAt(drag.anchor, float64(x)-origin.X, float64(y)-origin.Y, options)
	drag.preview = nil
	if drag.hit != nil {
		if card, _ := zoneOf(drag.hit); !slices.ContainsFunc(card, isPlace) {
			drag.preview = s.dropRect(drag.card, drag.hit)
		}
	}
	if drag.preview == nil {
		drag.hit = nil
	}
}

// targetOptions are the measures of the target search: the tab strip of a content card with its border, the edge share of a body and
// the width and the margin of the bands, the chrome metrics drop-band and drop-band-margin (docs/spec/groups.md#target-search).
func (s *Shell) targetOptions() layout.TargetOptions {
	header := float64(s.metrics.headH) + float64(s.palette.CardBorder())
	return layout.TargetOptions{HeaderPx: header, Edge: layout.DropEdge, Band: float64(s.metrics.dropBand), BandMargin: float64(s.metrics.dropBandMargin)}
}

// dropRect is the rectangle of the card that a drop produces, in the coordinates of the plane, and nil when the layout refuses the
// drop. The drop runs on the tree and the tree is put back, since a cut shares the gap between its two pieces and a move closes before
// it cuts, so half of the target is not where the card lands.
func (s *Shell) dropRect(from string, hit *layout.DropTarget) *layout.Rect {
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
func (s *Shell) dropCard(from string, hit *layout.DropTarget, data json.RawMessage) (string, error) {
	source, err := s.cardData(from)
	if err != nil {
		return "", err
	}
	single := len(source.TabList()) == 1
	target, zone := zoneOf(hit)
	switch {
	case zone == "centre" && !s.isGroup(target[0]):
		return target[0], nil
	case single && slices.Contains(target, from) && len(target) == 1:
		return "", fmt.Errorf("card %s cannot move beside itself", from)
	case single:
		if !s.planes.Moved(from, target, zone) {
			if err := s.planes.Move(from, target, zone); err != nil {
				return "", err
			}
		}
		return from, nil
	case zone == "centre":
		return s.planes.AddCard(target[0], data)
	}
	return s.planes.SplitBeside(target, zone, data)
}

// moveTab moves a tab to the centre or an edge of a card, as a drop does.
func (s *Shell) moveTab(tab string, card layout.Target, zone string) error {
	from := s.cardOfTab(tab)
	if from == "" {
		return fmt.Errorf("no tab %s", tab)
	}
	if len(card) == 0 {
		return fmt.Errorf("tab %s moves to no card", tab)
	}
	for _, id := range card {
		if err := s.paneCard(id); err != nil {
			return err
		}
	}
	if !slices.Contains(tabZones, zone) {
		return fmt.Errorf("unknown zone %s", zone)
	}
	if zone == "centre" && len(card) > 1 {
		return fmt.Errorf("tab %s moves to the centre of one card, not of %s", tab, strings.Join(card, ", "))
	}
	hit := &layout.DropTarget{Kind: "add", Target: card, Side: zone}
	if zone == "centre" {
		hit = &layout.DropTarget{Kind: "centre", Card: card[0]}
	}
	if (zone != "centre" || s.isGroup(card[0])) && s.dropRect(from, hit) == nil {
		return fmt.Errorf("tab %s cannot move to the %s of %s", tab, zone, strings.Join(card, ", "))
	}
	s.fullscreen = ""
	return s.dropTab(from, tab, hit)
}

// dropTab runs a drop. A drop on the centre of a content card moves the tab into the card, a drop of the only tab of a card moves the
// card, so no empty card remains, and a drop on a side or on the centre of a group card puts the tab into a new card (dropCard).
func (s *Shell) dropTab(from, tab string, hit *layout.DropTarget) error {
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
	if target, zone := zoneOf(hit); zone == "centre" && !s.isGroup(target[0]) {
		return s.dropOnCentre(from, source, moving, target[0])
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

// dragGroupTo takes the drop of the dragged group card at x and y of the plane by the target search, and the drop is the move of
// core.card.move, which the tree refuses or places (docs/spec/groups.md#moving-and-dropping). A group card has no tabs, so a tab strip
// and the centre of a content card are no target of it.
func (s *Shell) dragGroupTo(drag *tabDrag, x, y float64, options layout.TargetOptions) {
	drag.hit, drag.anchor = s.planes.DragAt(drag.anchor, x, y, options)
	drag.preview = nil
	if drag.hit != nil && drag.hit.Kind != "add" {
		drag.hit = nil
	}
	if drag.hit != nil && !slices.ContainsFunc(drag.hit.Target, isPlace) && s.planes.CheckMove(drag.card, drag.hit.Target, drag.hit.Side) == nil {
		hit := drag.hit
		err := s.planes.Probe(func() error {
			if err := s.planes.Move(drag.card, hit.Target, hit.Side); err != nil {
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
				s.binder.run("core.card.move", cardMoveParam{Card: id, Target: drag.hit.Target, Side: drag.hit.Side})
			} else {
				s.settle()
			}
			return true
		}
		return false
	}
}
