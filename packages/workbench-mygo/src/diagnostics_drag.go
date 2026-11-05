package workbench

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The drag of a boundary (diagnostics.drag of docs/spec/endpoint.md). The host delivers the gesture as native pointer input, which
// reaches the divider as a person's drag. The workbench answers the point of the boundary, and between diagnostics.drag and
// diagnostics.drag.end it records the position of the boundary before the drag and after each step.

// dragPlan names the boundary of a drag.
type dragPlan struct {
	Axis layout.Axis `json:"axis"`
	Line int         `json:"line"`
}

// boundaryDrag is the record of the drag that runs.
type boundaryDrag struct {
	boundary []float64
}

// registerDrag answers the point of a boundary and the record of a drag.
func (s *Shell) registerDrag() {
	s.registry.Method("diagnostics.drag", s.startDrag)
	s.registry.Method("diagnostics.drag.end", s.endDrag)
	s.registry.Method("diagnostics.drag.placed", s.dragPlaced)
	s.registry.Method("diagnostics.drag.boundary", func(raw json.RawMessage, answer func(any, error)) {
		plan, err := params[dragPlan](raw)
		if err != nil {
			answer(nil, Refuse(InvalidParams, "diagnostics.drag.boundary: %s", err))
			return
		}
		_, point, err := s.dragDivider(plan)
		if err != nil {
			answer(nil, err)
			return
		}
		answer(map[string]float64{"x": point.X, "y": point.Y}, nil)
	})
}

// dragDivider finds the first divider of the boundary of plan and the centre of its grab area in window content coordinates.
func (s *Shell) dragDivider(plan dragPlan) (layout.Divider, layout.Point, error) {
	for _, divider := range s.plane.Dividers() {
		if divider.Axis == plan.Axis && divider.Line == plan.Line {
			origin := s.planeOrigin()
			return divider, layout.Point{X: origin.X + divider.X + divider.W/2, Y: origin.Y + divider.Y + divider.H/2}, nil
		}
	}
	return layout.Divider{}, layout.Point{}, fmt.Errorf("no %s boundary at line %d", plan.Axis, plan.Line)
}

// startDrag starts the record of a drag of the boundary of the plan.
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
	if _, _, err := s.dragDivider(plan); err != nil {
		answer(nil, err)
		return
	}
	s.drag = &boundaryDrag{boundary: []float64{s.plane.BoundaryPos(plan.Axis, plan.Line)}}
	answer(nil, nil)
}

// endDrag ends the record of the drag and answers it.
func (s *Shell) endDrag(_ json.RawMessage, answer func(any, error)) {
	if s.drag == nil {
		answer(nil, errors.New("no drag of this window is running"))
		return
	}
	boundary := s.drag.boundary
	s.drag = nil
	answer(map[string]any{"boundary": boundary}, nil)
}

// dragPlaced answers after the host replied to the placement that holds every step of the drag. A placement that runs
// meanwhile holds none of the later steps, so it does not count, and a window with nothing to place answers at its next
// frame. It answers the failure of that placement.
func (s *Shell) dragPlaced(_ json.RawMessage, answer func(any, error)) {
	s.afterPlacement(func(err error) { answer(nil, err) })
}

// dragStepped records the position of the held boundary after a step of a drag. A held line that the step dropped renumbers.
func (s *Shell) dragStepped(held *heldDivider) {
	if s.drag != nil {
		s.drag.boundary = append(s.drag.boundary, s.plane.BoundaryPos(held.axis, held.line))
	}
}
