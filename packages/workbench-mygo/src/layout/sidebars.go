package layout

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"
)

// The sidebars of a card as packages/workbench/card-sidebars.js gives them: the stored choice of each side, its effect, and the presentation
// of the requested sides in the card. The shared layout cases of docs/spec/cases/layout/sidebars.json state them.

// SidebarSides are the sides of a card.
var SidebarSides = []Side{"top", "bottom", "left", "right"}

// SidebarDefaults are the common size settings of the card sidebars.
type SidebarDefaults struct {
	Size float64 `json:"size"`
	Min  float64 `json:"min"`
	Max  float64 `json:"max"`
}

// Sidebar is the effect of the stored choice of a side.
type Sidebar struct {
	Set       string  `json:"set"`
	Size      float64 `json:"size"`
	Collapsed bool    `json:"collapsed"`
}

func assertSide(side Side) error {
	if !slices.Contains(SidebarSides, side) {
		return errors.New("unknown sidebar side " + side)
	}
	return nil
}

// sidebarState is the stored choice of a side. Every stored side is checked, and a side without a choice has no member.
func sidebarState(id string, d *CardData, side Side) (map[string]json.RawMessage, error) {
	if err := assertSide(side); err != nil {
		return nil, err
	}
	if d == nil {
		return nil, errors.New("card " + id + " has no content")
	}
	for _, key := range []string{"panels", "sidebar"} {
		if _, ok := d.Rest[key]; ok {
			return nil, errors.New("obsolete card sidebar state on card " + id)
		}
	}
	if d.Sidebars == nil {
		return map[string]json.RawMessage{}, nil
	}
	sides, keys, ok := object(d.Sidebars)
	if !ok {
		return nil, errors.New("invalid card sidebars state")
	}
	for _, key := range keys {
		entry, fields, ok := object(sides[key])
		if !slices.Contains(SidebarSides, key) || !ok {
			return nil, errors.New("invalid card sidebar state")
		}
		for _, field := range fields {
			if field != "set" && field != "size" && field != "collapsed" {
				return nil, errors.New("invalid sidebar field " + field)
			}
		}
		if raw, ok := entry["set"]; ok {
			var set string
			if jsonKind(raw) != '"' || json.Unmarshal(raw, &set) != nil || set == "" || set == "inherit" {
				return nil, errors.New("invalid sidebar set")
			}
		}
		if raw, ok := entry["size"]; ok && jsonKind(raw) != '0' {
			return nil, errors.New("invalid sidebar size")
		}
		if raw, ok := entry["collapsed"]; ok && jsonKind(raw) != 'b' {
			return nil, errors.New("invalid sidebar collapsed state")
		}
	}
	if raw, ok := sides[side]; ok {
		// silent: the loop above refused a side that is not an object.
		entry, _, _ := object(raw)
		return entry, nil
	}
	return map[string]json.RawMessage{}, nil
}

// storeSidebar writes the choice of a side.
func storeSidebar(d *CardData, side Side, next map[string]json.RawMessage) error {
	sides := map[string]json.RawMessage{}
	if d.Sidebars != nil {
		if err := json.Unmarshal(d.Sidebars, &sides); err != nil {
			return err
		}
	}
	entry, err := json.Marshal(next)
	if err != nil {
		return err
	}
	sides[side] = entry
	stored, err := json.Marshal(sides)
	if err != nil {
		return err
	}
	d.Sidebars = stored
	return nil
}

// EffectiveSidebar is the effect of the choice of a side, nil for a side that is off. Without an explicit choice the set is linked, the id
// of the default link of the active plugin, and without that the side is off (docs/spec/example-model.md).
func EffectiveSidebar(id string, d *CardData, side Side, defaults SidebarDefaults, linked *string) (*Sidebar, error) {
	own, err := sidebarState(id, d, side)
	if err != nil {
		return nil, err
	}
	effective := Sidebar{Size: defaults.Size}
	if raw, ok := own["size"]; ok {
		if err := json.Unmarshal(raw, &effective.Size); err != nil {
			return nil, err
		}
		if effective.Size < defaults.Min || effective.Size > defaults.Max {
			return nil, errors.New("invalid sidebar size outside " + jsString(defaults.Min) + " to " + jsString(defaults.Max) + " points")
		}
	}
	if raw, ok := own["set"]; ok {
		if err := json.Unmarshal(raw, &effective.Set); err != nil {
			return nil, err
		}
	} else if linked != nil {
		effective.Set = *linked
	}
	if effective.Set == "" || effective.Set == "off" {
		return nil, nil
	}
	if raw, ok := own["collapsed"]; ok {
		if err := json.Unmarshal(raw, &effective.Collapsed); err != nil {
			return nil, err
		}
	}
	return &effective, nil
}

// ResolveSidebarSet is the set of a side in sets, nil for a side that is off.
func ResolveSidebarSet(id string, d *CardData, side Side, sets map[string]json.RawMessage, defaults SidebarDefaults, linked *string) (json.RawMessage, error) {
	current, err := EffectiveSidebar(id, d, side, defaults, linked)
	if err != nil || current == nil {
		return nil, err
	}
	set, ok := sets[current.Set]
	if !ok {
		return nil, errors.New("unknown sidebar set " + current.Set)
	}
	return set, nil
}

// SetSidebar stores the choice of a set for a side: off turns the side off, and inherit returns it to the link.
func SetSidebar(id string, d *CardData, side Side, choice string, sets map[string]json.RawMessage) error {
	next, err := sidebarState(id, d, side)
	if err != nil {
		return err
	}
	if _, ok := sets[choice]; !ok && choice != "off" && choice != "inherit" {
		return errors.New("unknown sidebar set " + choice)
	}
	if choice == "inherit" {
		delete(next, "set")
	} else {
		raw, err := json.Marshal(choice)
		if err != nil {
			return err
		}
		next["set"] = raw
	}
	return storeSidebar(d, side, next)
}

// ToggleSidebar inverts the visible state: a side that is shown collapsed opens, and a side that is shown open collapses.
func ToggleSidebar(id string, d *CardData, side Side, defaults SidebarDefaults, linked *string, shownCollapsed bool) error {
	current, err := EffectiveSidebar(id, d, side, defaults, linked)
	if err != nil {
		return err
	}
	if current == nil {
		return errors.New("card " + id + " has no " + side + " sidebar")
	}
	next, err := sidebarState(id, d, side)
	if err != nil {
		return err
	}
	if next["collapsed"], err = json.Marshal(!shownCollapsed); err != nil {
		return err
	}
	return storeSidebar(d, side, next)
}

// SizeSidebar stores the size of a side. A drag opens the side.
func SizeSidebar(id string, d *CardData, side Side, size float64, defaults SidebarDefaults, linked *string) error {
	current, err := EffectiveSidebar(id, d, side, defaults, linked)
	if err != nil {
		return err
	}
	if current == nil {
		return errors.New("card " + id + " has no " + side + " sidebar")
	}
	if !finite(size) || size < defaults.Min || size > defaults.Max {
		return errors.New("sidebar size must be " + jsString(defaults.Min) + " to " + jsString(defaults.Max) + " points")
	}
	next, err := sidebarState(id, d, side)
	if err != nil {
		return err
	}
	if next["collapsed"], err = json.Marshal(false); err != nil {
		return err
	}
	if next["size"], err = json.Marshal(size); err != nil {
		return err
	}
	return storeSidebar(d, side, next)
}

// DeviceGridSize is the display size of a stored size, aligned to the device pixel grid of the screen. The stored size does not change.
func DeviceGridSize(size, ratio float64) (float64, error) {
	if !finite(size) || !finite(ratio) || ratio <= 0 {
		return 0, errors.New("invalid sidebar size or device pixel ratio")
	}
	// float64 rounds the product before it is rounded to a pixel, as JavaScript does (number.go).
	return jsRound(float64(size*ratio)) / ratio, nil
}

// SidebarRequest is the effect of the choice of a side, which the presentation fits into the card.
type SidebarRequest struct {
	Set       *string `json:"set,omitempty"`
	Size      float64 `json:"size"`
	Collapsed bool    `json:"collapsed"`
}

// SidebarMetrics are the lengths of a card that bound its sidebars.
type SidebarMetrics struct {
	Header         float64 `json:"header"`
	Footer         float64 `json:"footer"`
	Border         float64 `json:"border"`
	Divider        float64 `json:"divider"`
	Minimum        float64 `json:"minimum"`
	SidebarMinimum float64 `json:"sidebarMinimum"`
}

// PresentedSidebar is a side as the card shows it. Collapsed holds the requested choice or the collapse that the lack of space caused, which
// AutoCollapsed and CollapseReason name. ShownSize is nil for a side that takes only the grip width.
type PresentedSidebar struct {
	Set                *string  `json:"set,omitempty"`
	Size               float64  `json:"size"`
	Collapsed          bool     `json:"collapsed"`
	RequestedCollapsed bool     `json:"requestedCollapsed"`
	AutoCollapsed      bool     `json:"autoCollapsed"`
	CollapseReason     *string  `json:"collapseReason"`
	ShownSize          *float64 `json:"shownSize"`
}

// PresentSidebars applies the stored expansion choice to the current card space (docs/spec/example-model.md). It does not change the stored
// size and choice; it only decides the visible size and the automatic collapse caused by lack of space. prefer is the side operated last on
// each axis, keyed width and height.
func PresentSidebars(requested map[Side]SidebarRequest, rect Rect, metrics SidebarMetrics, prefer map[string]Side) (map[Side]PresentedSidebar, error) {
	for _, value := range []float64{rect.W, rect.H, metrics.Header, metrics.Footer, metrics.Border, metrics.Divider, metrics.Minimum, metrics.SidebarMinimum} {
		if !finite(value) || value < 0 {
			return nil, errors.New("invalid sidebar presentation geometry")
		}
	}
	if metrics.Minimum == 0 {
		return nil, errors.New("invalid sidebar presentation geometry")
	}
	sides := make([]Side, 0, len(requested))
	for side := range requested {
		sides = append(sides, side)
	}
	sort.Strings(sides)
	for _, side := range sides {
		if err := assertSide(side); err != nil {
			return nil, err
		}
		if state := requested[side]; !finite(state.Size) || state.Size < 0 {
			return nil, errors.New("invalid sidebar presentation state")
		}
	}
	result := map[Side]PresentedSidebar{}
	for _, axis := range []struct {
		name  string
		sides []Side
	}{{"width", []Side{"left", "right"}}, {"height", []Side{"top", "bottom"}}} {
		var open []Side
		folded := 0
		total := 0.0
		for _, side := range axis.sides {
			state, ok := requested[side]
			if !ok {
				continue
			}
			if state.Collapsed {
				folded++
			} else {
				open = append(open, side)
				total += state.Size
			}
		}
		// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
		extent := rect.W - float64(2*metrics.Border)
		if axis.name == "height" {
			extent = rect.H - float64(2*metrics.Border) - metrics.Header - metrics.Footer
		}
		room := extent - metrics.Minimum - float64(float64(folded)*metrics.Divider)
		shown := fitOpenSides(open, requested, total, room, metrics, prefer[axis.name])
		for _, side := range axis.sides {
			state, ok := requested[side]
			if !ok {
				continue
			}
			size, isShown := shown[side]
			automatic := !state.Collapsed && !isShown
			presented := PresentedSidebar{
				Set: state.Set, Size: state.Size, Collapsed: state.Collapsed || automatic,
				RequestedCollapsed: state.Collapsed, AutoCollapsed: automatic,
			}
			if automatic {
				reason := "insufficient-" + axis.name
				presented.CollapseReason = &reason
			}
			if isShown {
				presented.ShownSize = &size
			}
			result[side] = presented
		}
	}
	return result, nil
}

// fitOpenSides is the shown size of the open sides of one axis: their sizes when they fit, sizes in proportion when each stays over the
// minimum, and otherwise only the side operated last, or the first side, when it still fits.
func fitOpenSides(open []Side, requested map[Side]SidebarRequest, total, room float64, metrics SidebarMetrics, prefer Side) map[Side]float64 {
	shown := map[Side]float64{}
	if total <= room {
		for _, side := range open {
			shown[side] = requested[side].Size
		}
		return shown
	}
	everyFits := true
	for _, side := range open {
		// float64 rounds the product before it is divided, as JavaScript does (number.go).
		shown[side] = float64(requested[side].Size*room) / total
		everyFits = everyFits && shown[side] >= metrics.SidebarMinimum
	}
	if everyFits {
		return shown
	}
	first := open[0]
	if slices.Contains(open, prefer) {
		first = prefer
	}
	// float64 rounds the product before it is added, as JavaScript does; without it Go may fuse them (number.go).
	alone := math.Min(requested[first].Size, room-float64(float64(len(open)-1)*metrics.Divider))
	shown = map[Side]float64{}
	if alone >= metrics.SidebarMinimum {
		shown[first] = alone
	}
	return shown
}

// SideName is the Korean name of a side.
func SideName(side Side) string {
	return map[Side]string{"top": "위", "bottom": "아래", "left": "왼쪽", "right": "오른쪽"}[side]
}

// SpaceFoldText is the status line text that names the sides folded for lack of space, or "" without such a side.
func SpaceFoldText(presented map[Side]PresentedSidebar) string {
	var names []string
	for _, side := range SidebarSides {
		if shown, ok := presented[side]; ok && shown.AutoCollapsed && !shown.RequestedCollapsed {
			names = append(names, SideName(side))
		}
	}
	if len(names) == 0 {
		return ""
	}
	return strings.Join(names, "·") + " 사이드바: 공간 부족으로 접힘"
}

// KeepWindowSidebarWidths copies the size drawn on its axis of the fixed sidebar cards of the plane into records: the width of a left or
// right card, the height of a top or bottom card.
func KeepWindowSidebarWidths(g *Grid, records map[string]WindowSidebar) {
	for _, card := range g.Cards() {
		if !isWindowSidebar(card.ID) {
			continue
		}
		size := card.Width
		if WindowAxis(card.ID) == "y" {
			size = card.Height
		}
		if size != nil {
			records[card.ID] = SidebarSize(card.ID, *size)
		}
	}
}

// ArrangedSides are the sides that hold a window sidebar, in the order: a side that has a choice (sides) and whose switch is on.
func ArrangedSides(order, sides []string, shown func(side string) bool) []string {
	arranged := []string{}
	for _, side := range order {
		if slices.Contains(sides, side) && shown(side) {
			arranged = append(arranged, side)
		}
	}
	return arranged
}

// ArrangedPlace is the place that the order gives the sidebar of a side, in grid lines: Line is the line of its side on Axis, and From
// and To its range on the other axis.
type ArrangedPlace struct {
	Axis           Axis
	Line, From, To int
}

// ArrangedPlaces is the place that the order gives the sidebar of each arranged side: the line of its side on its axis, and its range on
// the other axis from the border or the inner line of the sidebar of an earlier side of that axis to the opposite border or the inner
// line of such a sidebar (docs/spec/external-sidebars.md#fixed-placement-and-persistence). An earlier side whose sidebar is not on the
// plane leaves the border.
func ArrangedPlaces(g *Grid, arranged []string) map[string]ArrangedPlace {
	last := map[Axis]int{"x": len(g.Lines("x")) - 1, "y": len(g.Lines("y")) - 1}
	places := map[string]ArrangedPlace{}
	for index, side := range arranged {
		axis := WindowAxis(side)
		cross, low, high := Axis("y"), "top", "bottom"
		if axis == "y" {
			cross, low, high = "x", "left", "right"
		}
		earlier := arranged[:index]
		place := ArrangedPlace{Axis: axis, From: 0, To: last[cross]}
		if side == "right" || side == "bottom" {
			place.Line = last[axis]
		}
		if card, ok := g.Card(low); ok && slices.Contains(earlier, low) {
			place.From = card.R1
			if cross == "x" {
				place.From = card.C1
			}
		}
		if card, ok := g.Card(high); ok && slices.Contains(earlier, high) {
			place.To = card.R0
			if cross == "x" {
				place.To = card.C0
			}
		}
		places[side] = place
	}
	return places
}

// WindowSidebarsArranged is whether the window sidebars of g stand where the order places the arranged sides, and no other window sidebar is
// on the plane.
func WindowSidebarsArranged(g *Grid, arranged []string) bool {
	present := 0
	for _, card := range g.Cards() {
		if isWindowSidebar(card.ID) {
			present++
			if !slices.Contains(arranged, card.ID) {
				return false
			}
		}
	}
	if present != len(arranged) {
		return false
	}
	places := ArrangedPlaces(g, arranged)
	for _, side := range arranged {
		card, _ := g.Card(side) // silent: every arranged side is present, counted above.
		place := places[side]
		own0, own1, cross0, cross1 := card.C0, card.C1, card.R0, card.R1
		if place.Axis == "y" {
			own0, own1, cross0, cross1 = card.R0, card.R1, card.C0, card.C1
		}
		atSide := own1 == place.Line
		if side == "left" || side == "top" {
			atSide = own0 == place.Line
		}
		if !card.Fixed || !atSide || cross0 != place.From || cross1 != place.To {
			return false
		}
	}
	return true
}

// ArrangeWindowSidebars arranges the window sidebars in the order (docs/spec/external-sidebars.md#fixed-placement-and-persistence). order
// lists the four sides, sides are the sides that have a choice, and shown is the switch of a side. When the window sidebars of the plane
// already stand where the order places them, nothing moves, so a change of focus or of the override does not move a sidebar. Otherwise
// every window sidebar is closed, the lines that no card references are removed, and the arranged sides are inserted in the reverse of the
// order at the border line of their side with their saved size and set fixed, so the first side reaches across the plane. A sidebar whose
// only filler is a fixed card while its slots hold another card cannot leave yet (R7 of packages/soksak/docs/layout.md); it leaves after
// the others. A sidebar without a record starts with initialWidth on its axis. It tells whether the plane changed.
func ArrangeWindowSidebars(g *Grid, order, sides []string, records map[string]WindowSidebar, initialWidth float64, shown func(side string) bool) (bool, error) {
	if !finite(initialWidth) || initialWidth <= 0 {
		return false, errors.New("invalid initial window sidebar width")
	}
	arranged := ArrangedSides(order, sides, shown)
	for _, side := range arranged {
		if _, ok := records[side]; !ok {
			records[side] = SidebarSize(side, initialWidth)
		}
	}
	for _, card := range g.Cards() {
		if _, ok := records[card.ID]; isWindowSidebar(card.ID) && !ok {
			records[card.ID] = SidebarSize(card.ID, initialWidth)
		}
	}
	KeepWindowSidebarWidths(g, records)
	if WindowSidebarsArranged(g, arranged) {
		return false, nil
	}
	for {
		left := []string{}
		for _, card := range g.Cards() {
			if isWindowSidebar(card.ID) {
				left = append(left, card.ID)
			}
		}
		if len(left) == 0 {
			break
		}
		closed := false
		// A sidebar that cannot leave yet waits until another window sidebar has left.
		for _, id := range left {
			g.SetFixed(id, false)
			if g.Close(id) {
				closed = true
				break
			}
			g.SetFixed(id, true)
		}
		if !closed {
			return true, fmt.Errorf("cannot remove window sidebars %s", strings.Join(left, ", "))
		}
		// A closed card leaves its lines, and a sidebar that opens again adds new ones, so the lines would pile up in one slot.
		g.Tidy()
	}
	for i := len(arranged) - 1; i >= 0; i-- {
		side := arranged[i]
		axis := WindowAxis(side)
		line := 0
		if side == "right" || side == "bottom" {
			line = len(g.Lines(axis)) - 1
		}
		if !g.CanInsertAt(axis, line, "") {
			return true, fmt.Errorf("cannot place window sidebar %s", side)
		}
		id, size := side, records[side].Size()
		if _, ok := g.InsertAt(axis, line, InsertInit{ID: &id, Size: &size}); !ok {
			return true, fmt.Errorf("cannot place window sidebar %s", side)
		}
		g.SetFixed(side, true)
	}
	return true, nil
}

// WindowSidebarsPlaced is whether the window sidebars stand where the order places them (docs/spec/external-sidebars.md#verification):
// each is fixed, stands at the border line of its side, reaches along the other axis between the sidebars of earlier sides of that
// axis, and is drawn no larger on its axis than its saved size.
func WindowSidebarsPlaced(g *Grid, order []string) bool {
	present := map[string]bool{}
	rects := g.Rects()
	for _, card := range g.Cards() {
		if !isWindowSidebar(card.ID) {
			continue
		}
		present[card.ID] = true
		saved, drawn := card.Width, rects[card.ID].W
		if WindowAxis(card.ID) == "y" {
			saved, drawn = card.Height, rects[card.ID].H
		}
		if saved != nil && drawn > *saved+.5 {
			return false
		}
	}
	arranged := []string{}
	for _, side := range order {
		if present[side] {
			arranged = append(arranged, side)
		}
	}
	return WindowSidebarsArranged(g, arranged)
}
