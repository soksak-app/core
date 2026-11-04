package layout

import (
	"sort"
	"strconv"
	"strings"
)

// An arrangement built by splitting is a slicing floorplan: one a single cut can divide in two, recursively. A close must leave it
// slicing, or cards appear that no neighbour can fill.

// spanOnly is a card's extent only. The slicing check reads regions, not identities.
type spanOnly struct {
	c0, c1, r0, r1 int
}

func (s *spanOnly) get(k spanKey) int {
	switch k {
	case keyC0:
		return s.c0
	case keyC1:
		return s.c1
	case keyR0:
		return s.r0
	default:
		return s.r1
	}
}

func (s *spanOnly) set(k spanKey, v int) {
	switch k {
	case keyC0:
		s.c0 = v
	case keyC1:
		s.c1 = v
	case keyR0:
		s.r0 = v
	default:
		s.r1 = v
	}
}

func spansOf(cards []*Card) []spanOnly {
	out := make([]spanOnly, len(cards))
	for i, c := range cards {
		out[i] = spanOnly{c.C0, c.C1, c.R0, c.R1}
	}
	return out
}

func sliceKey(list []spanOnly) string {
	parts := make([]string, len(list))
	for i, r := range list {
		parts[i] = strconv.Itoa(r.c0) + "," + strconv.Itoa(r.c1) + "," + strconv.Itoa(r.r0) + "," + strconv.Itoa(r.r1)
	}
	sort.Strings(parts)
	return strings.Join(parts, "|")
}

// isSlicing is whether one cut can divide the regions in two, all the way down. memo holds the answers by arrangement.
func isSlicing(list []spanOnly, memo map[string]bool) bool {
	k := sliceKey(list)
	if hit, ok := memo[k]; ok {
		return hit
	}
	answer := len(list) <= 1
	if !answer {
	outer:
		for _, axis := range axes {
			lo, hi := span(axis)
			seen := map[int]bool{}
			for _, r := range list {
				at := r.get(hi)
				if seen[at] {
					continue
				}
				seen[at] = true
				var before, after []spanOnly
				for _, s := range list {
					if s.get(hi) <= at {
						before = append(before, s)
					}
					if s.get(lo) >= at {
						after = append(after, s)
					}
				}
				if len(before) == 0 || len(after) == 0 || len(before)+len(after) != len(list) {
					continue
				}
				if isSlicing(before, memo) && isSlicing(after, memo) {
					answer = true
					break outer
				}
			}
		}
	}
	if len(memo) > 4000 {
		clear(memo)
	}
	memo[k] = answer
	return answer
}

// Fill is the cards that take a closed card's space, the side they come from and the span key each of them expands by.
type Fill struct {
	Side  string `json:"side"`
	Grow  string `json:"grow"`
	Cards []Card `json:"cards"`
}

// fill is a Fill holding the stored cards, so a close can change them.
type fill struct {
	side  string
	grow  spanKey
	cards []*Card
}

type direction struct {
	side    string
	grow    spanKey
	touches func(c, x *Card) bool
	lo, hi  spanKey
}

var directions = map[string]direction{
	"below": {"below", keyR0, func(c, x *Card) bool { return c.R0 == x.R1 }, keyC0, keyC1},
	"above": {"above", keyR1, func(c, x *Card) bool { return c.R1 == x.R0 }, keyC0, keyC1},
	"right": {"right", keyC0, func(c, x *Card) bool { return c.C0 == x.C1 }, keyR0, keyR1},
	"left":  {"left", keyC1, func(c, x *Card) bool { return c.C1 == x.C0 }, keyR0, keyR1},
}

var fillOrders = map[string][]string{
	"v": {"below", "above", "right", "left"},
	"h": {"right", "left", "below", "above"},
}

var spanNames = map[spanKey]string{keyC0: "c0", keyC1: "c1", keyR0: "r0", keyR1: "r1"}

// fillFor is the neighbours that take a closed card's space, or nil. The result remains slicing, which keeps every card closable.
func fillFor(cards []*Card, closing *Card, order string, memo map[string]bool) *fill {
	if closing.Fixed {
		return nil
	}
	free := 0
	for _, c := range cards {
		if !c.Fixed {
			free++
		}
	}
	if free <= 1 {
		return nil
	}
	for _, side := range fillOrders[order] {
		dir := directions[side]
		var row []*Card
		for _, c := range cards {
			if c != closing && !c.Fixed && dir.touches(c, closing) && c.get(dir.lo) >= closing.get(dir.lo) && c.get(dir.hi) <= closing.get(dir.hi) {
				row = append(row, c)
			}
		}
		sort.SliceStable(row, func(a, b int) bool { return row[a].get(dir.lo) < row[b].get(dir.lo) })
		if len(row) == 0 {
			continue
		}
		at := closing.get(dir.lo)
		tiles := true
		for _, card := range row {
			if card.get(dir.lo) != at {
				tiles = false
				break
			}
			at = card.get(dir.hi)
		}
		if !tiles || at != closing.get(dir.hi) {
			continue
		}
		in := map[*Card]bool{}
		for _, c := range row {
			in[c] = true
		}
		after := []spanOnly{}
		for _, c := range cards {
			if c == closing {
				continue
			}
			s := spanOnly{c.C0, c.C1, c.R0, c.R1}
			if in[c] {
				s.set(dir.grow, closing.get(dir.grow))
			}
			after = append(after, s)
		}
		if isSlicing(after, memo) {
			return &fill{side: side, grow: dir.grow, cards: row}
		}
	}
	return nil
}
