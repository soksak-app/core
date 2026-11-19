// Package layout is the layout model of the workbench: the grid and card geometry of packages/soksak and the projects, spaces
// and tabs of packages/workbench, with their stored formats. It imports no package of a user interface. The shared layout cases
// of docs/spec/cases/layout state its behavior, and packages/soksak and packages/workbench meet the same cases.
package layout

import (
	"encoding/json"
	"math"
)

// Axis is "x" or "y". Every method that takes one refuses another value as the JavaScript grid does.
type Axis = string

// Side is "left", "right", "top" or "bottom".
type Side = string

// Rect is a rectangle in px.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Card is one card of the plane: a span of slots on each axis. Width and Height are px sizes that apply to a card spanning one
// slot on that axis; Fixed sets whether the layout may split, close or move it; Data is the payload of the host, which the grid
// does not read.
type Card struct {
	ID     string          `json:"id"`
	C0     int             `json:"c0"`
	C1     int             `json:"c1"`
	R0     int             `json:"r0"`
	R1     int             `json:"r1"`
	Width  *float64        `json:"width,omitempty"`
	Height *float64        `json:"height,omitempty"`
	Fixed  bool            `json:"fixed"`
	Data   json.RawMessage `json:"data,omitempty"`
}

// spanKeys names the two span fields of an axis.
type spanKey int

const (
	keyC0 spanKey = iota
	keyC1
	keyR0
	keyR1
)

// span returns the two span keys of an axis.
func span(axis Axis) (spanKey, spanKey) {
	if axis == "x" {
		return keyC0, keyC1
	}
	return keyR0, keyR1
}

// low is the span key of the lower line of an axis.
func low(axis Axis) spanKey {
	lo, _ := span(axis) // silent: this names the first of the two keys that span returns.
	return lo
}

func (c *Card) get(k spanKey) int {
	switch k {
	case keyC0:
		return c.C0
	case keyC1:
		return c.C1
	case keyR0:
		return c.R0
	default:
		return c.R1
	}
}

func (c *Card) set(k spanKey, v int) {
	switch k {
	case keyC0:
		c.C0 = v
	case keyC1:
		c.C1 = v
	case keyR0:
		c.R0 = v
	default:
		c.R1 = v
	}
}

// axes lists the two axes in the order the grid walks them.
var axes = [2]Axis{"x", "y"}

// sides lists every side a card can be split toward.
var sides = [4]Side{"left", "right", "top", "bottom"}

func axisOf(side Side) Axis {
	if side == "left" || side == "right" {
		return "x"
	}
	return "y"
}

// isAhead is true when the side is before the card on its axis.
func isAhead(side Side) bool { return side == "left" || side == "top" }

func spanOf(c *Card, axis Axis) int {
	lo, hi := span(axis)
	return c.get(hi) - c.get(lo)
}

// fixedSize is the px size set on an axis, or nil when the card takes a share.
func fixedSize(c *Card, axis Axis) *float64 {
	if spanOf(c, axis) != 1 {
		return nil
	}
	size := c.Width
	if axis != "x" {
		size = c.Height
	}
	if size == nil || math.IsNaN(*size) || math.IsInf(*size, 0) {
		return nil
	}
	v := math.Max(0, *size)
	return &v
}

func other(axis Axis) Axis {
	if axis == "x" {
		return "y"
	}
	return "x"
}

func setSizeOn(c *Card, axis Axis, v float64) {
	if axis == "x" {
		c.Width = &v
	} else {
		c.Height = &v
	}
}

func clearSizeOn(c *Card, axis Axis) {
	if axis == "x" {
		c.Width = nil
	} else {
		c.Height = nil
	}
}

func copyCard(c *Card) Card {
	out := *c
	if c.Width != nil {
		w := *c.Width
		out.Width = &w
	}
	if c.Height != nil {
		h := *c.Height
		out.Height = &h
	}
	if c.Data != nil {
		out.Data = append(json.RawMessage(nil), c.Data...)
	}
	return out
}
