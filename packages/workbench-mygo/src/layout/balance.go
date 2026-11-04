package layout

import (
	"math"
	"sort"
)

// Fair sizes for an arrangement that is kept. A slicing arrangement reads as a slicing tree; a card counts one along each axis, a
// cut along an axis counts the sum of its sides and a cut along the other axis counts the side that holds the most. A card with a
// px size on an axis keeps the size it is drawn at and counts nothing there.

// slice is a card, or a cut along axis into sides ordered from the plane's start.
type slice struct {
	card  *Card
	axis  Axis
	sides []*slice
}

// sliceTree is the slicing tree of an arrangement, or nil when it is not slicing.
func sliceTree(cards []*Card) *slice {
	if len(cards) == 1 {
		return &slice{card: cards[0]}
	}
	if len(cards) == 0 {
		return nil
	}
	for _, axis := range axes {
		lo, hi := span(axis)
		start, end := cards[0].get(lo), cards[0].get(hi)
		for _, c := range cards {
			start = min(start, c.get(lo))
			end = max(end, c.get(hi))
		}
		seen := map[int]bool{}
		cuts := []int{}
		for _, c := range cards {
			at := c.get(hi)
			if seen[at] {
				continue
			}
			seen[at] = true
			if at >= end {
				continue
			}
			clean := true
			for _, o := range cards {
				if !(o.get(hi) <= at || o.get(lo) >= at) {
					clean = false
					break
				}
			}
			if clean {
				cuts = append(cuts, at)
			}
		}
		sort.Ints(cuts)
		if len(cuts) == 0 {
			continue
		}
		bounds := append(append([]int{start}, cuts...), end)
		sides := []*slice{}
		for i := 0; i+1 < len(bounds); i++ {
			var part []*Card
			for _, c := range cards {
				if c.get(lo) >= bounds[i] && c.get(hi) <= bounds[i+1] {
					part = append(part, c)
				}
			}
			side := sliceTree(part)
			if side == nil {
				return nil
			}
			sides = append(sides, side)
		}
		return &slice{axis: axis, sides: sides}
	}
	return nil
}

// weight is how many fair shares a slice takes along an axis.
func weight(s *slice, axis Axis) float64 {
	if s.card != nil {
		if fixedSize(s.card, axis) == nil {
			return 1
		}
		return 0
	}
	total, most := 0.0, math.Inf(-1)
	for _, side := range s.sides {
		w := weight(side, axis)
		total += w
		most = math.Max(most, w)
	}
	if s.axis == axis {
		return total
	}
	return most
}

// region is a region of the plane in px, from line to line, and which of its edges are the plane's border.
type region struct {
	x0, x1, y0, y1           float64
	left, right, top, bottom bool
}

func (r *region) ends(axis Axis) (*float64, *float64) {
	if axis == "x" {
		return &r.x0, &r.x1
	}
	return &r.y0, &r.y1
}

func (r *region) edges(axis Axis) (*bool, *bool) {
	if axis == "x" {
		return &r.left, &r.right
	}
	return &r.top, &r.bottom
}

// balanceRegions is the region of every card once the slice is balanced inside reg. drawn is the size a card with a px size is drawn
// at on an axis; gap is the corridor between two neighbours.
func balanceRegions(s *slice, reg region, gap float64, drawn func(*Card, Axis) float64, out map[string]region) {
	if s.card != nil {
		out[s.card.ID] = reg
		return
	}
	axis := s.axis
	half := gap / 2
	count := len(s.sides)
	held := make([]opt, count)
	shares := make([]float64, count)
	for i, side := range s.sides {
		if side.card != nil && fixedSize(side.card, axis) != nil {
			held[i] = some(drawn(side.card, axis))
		}
		shares[i] = weight(side, axis)
	}
	from, to := reg.ends(axis)
	startEdge, endEdge := reg.edges(axis)
	content := *to - *from
	if !*startEdge {
		content -= half
	}
	if !*endEdge {
		content -= half
	}
	free := content - float64(float64(count-1)*gap)
	total := 0.0
	for i := range s.sides {
		if held[i].ok {
			free -= held[i].v
		} else {
			free -= float64(math.Max(0, shares[i]-1) * gap)
			total += shares[i]
		}
	}
	unit := 0.0
	if total > 0 {
		unit = math.Max(0, free) / total
	}
	cursor := *from
	for i, side := range s.sides {
		first, last := i == 0, i == count-1
		size := float64(shares[i]*unit) + float64(math.Max(0, shares[i]-1)*gap)
		if held[i].ok {
			size = held[i].v
		}
		extent := size
		if !(first && *startEdge) {
			extent += half
		}
		if !(last && *endEdge) {
			extent += half
		}
		part := reg
		pFrom, pTo := part.ends(axis)
		pStart, pEnd := part.edges(axis)
		*pFrom = cursor
		if !last {
			*pTo = cursor + extent
		}
		*pStart = first && *startEdge
		*pEnd = last && *endEdge
		balanceRegions(side, part, gap, drawn, out)
		cursor += extent
	}
}
