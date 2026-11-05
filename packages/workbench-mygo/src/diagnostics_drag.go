package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The drag of a boundary on the clock of the host (diagnostics.drag of docs/spec/endpoint.md), as packages/workbench/observe.js
// drives it in a page: a press at the centre of the grab area, a move at each diagnostics-tick event out to the offset of the plan
// and back, and a release, each through the input of the boundary as a person's drag.

// dragFrame is the length of one step in milliseconds, the interval at which the host sends the ticks.
const dragFrame = 16

// dragPlan is the request of a drag.
type dragPlan struct {
	Axis  layout.Axis `json:"axis"`
	Line  int         `json:"line"`
	DX    float64     `json:"dx"`
	DY    float64     `json:"dy"`
	MS    int         `json:"ms"`
	Times int         `json:"times"`
}

// boundaryDrag is the drag that runs. It keeps the element that the press reached, as the press keeps it for a person.
type boundaryDrag struct {
	plan     dragPlan
	from     layout.Point
	steps    int
	ticks    int
	input    func(ui.InputEvent) bool
	divider  layout.Divider
	began    time.Time
	boundary []float64
	handled  []float64
	answer   func(any, error)
}

// registerDrag answers the drag of a boundary and the point of a boundary.
func (s *Shell) registerDrag() {
	s.registry.Method("diagnostics.drag", s.startDrag)
	s.registry.Method("diagnostics.drag.boundary", func(raw json.RawMessage, answer func(any, error)) {
		plan, err := params[dragPlan](raw)
		if err != nil {
			answer(nil, Refuse(InvalidParams, "diagnostics.drag.boundary: %s", err))
			return
		}
		_, _, point, err := s.dragDivider(plan)
		if err != nil {
			answer(nil, err)
			return
		}
		answer(map[string]float64{"x": point.X, "y": point.Y}, nil)
	})
}

// dragDivider finds the first divider of the boundary of plan, its element and the centre of its grab area in window content coordinates.
func (s *Shell) dragDivider(plan dragPlan) (layout.Divider, string, layout.Point, error) {
	dividers := s.plane.Dividers()
	items := s.items(dividers)
	for i, divider := range dividers {
		if divider.Axis == plan.Axis && divider.Line == plan.Line {
			origin := s.planeOrigin()
			return divider, items[i], layout.Point{X: origin.X + divider.X + divider.W/2, Y: origin.Y + divider.Y + divider.H/2}, nil
		}
	}
	return layout.Divider{}, "", layout.Point{}, fmt.Errorf("no %s boundary at line %d", plan.Axis, plan.Line)
}

// startDrag presses the boundary of the plan. The ticks of the host do the rest, and the last one answers.
func (s *Shell) startDrag(raw json.RawMessage, answer func(any, error)) {
	plan, err := params[dragPlan](raw)
	if err != nil {
		answer(nil, Refuse(InvalidParams, "diagnostics.drag: %s", err))
		return
	}
	if s.drag != nil {
		answer(nil, errors.New("another drag of this window is running"))
		return
	}
	divider, item, from, err := s.dragDivider(plan)
	if err != nil {
		answer(nil, err)
		return
	}
	drag := &boundaryDrag{
		plan: plan, from: from, steps: max(1, int(math.Round(float64(plan.MS)/dragFrame))), divider: divider,
		input: s.dividerInput(divider, item), answer: answer,
	}
	s.drag = drag
	drag.send(ui.InputPointerDown, 0)
	drag.boundary = []float64{s.plane.BoundaryPos(plan.Axis, s.draggedLine())}
	drag.began = time.Now()
}

// send delivers an input of the press at fraction of the offset of the plan from the centre of the grab area.
func (d *boundaryDrag) send(kind ui.InputKind, fraction float64) {
	d.input(ui.InputEvent{
		Kind: kind, Clicks: 1,
		X: float32(d.divider.W/2 + d.plan.DX*fraction),
		Y: float32(d.divider.H/2 + d.plan.DY*fraction),
	})
}

// draggedLine is the line of the boundary that the press holds, which a line that the move dropped renumbers.
func (s *Shell) draggedLine() int {
	if s.held != nil {
		return s.held.line
	}
	return s.drag.plan.Line
}

// dragTick moves the press one step, and after the last step releases it and answers.
func (s *Shell) dragTick() {
	d := s.drag
	if d == nil {
		return
	}
	turn, step := d.ticks/d.steps, d.ticks%d.steps+1
	d.ticks++
	fraction := float64(step) / float64(d.steps)
	if turn%2 == 1 {
		fraction = 1 - fraction
	}
	began := time.Now()
	d.send(ui.InputPointerMove, fraction)
	d.boundary = append(d.boundary, s.plane.BoundaryPos(d.plan.Axis, s.draggedLine()))
	d.handled = append(d.handled, math.Round(float64(time.Since(began).Microseconds())/100)/10)
	total := d.plan.Times * 2 * d.steps
	if d.ticks < total {
		return
	}
	took := time.Since(d.began).Milliseconds()
	d.send(ui.InputPointerUp, 0)
	s.drag = nil
	d.answer(map[string]any{
		"from": map[string]float64{"x": d.from.X, "y": d.from.Y}, "steps": total, "took": took, "asked": total * dragFrame,
		"late": 0, "deepest": 0, "boundary": d.boundary, "handled": d.handled,
	}, nil)
}
