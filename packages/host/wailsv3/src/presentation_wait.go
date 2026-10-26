package host

import (
	"fmt"
	"unsafe"
)

// presentationPlacement is the last accepted placement of one plugin root view.
type presentationPlacement struct {
	rect       Rect
	visible    bool
	generation uint64
}

// presentationJoin identifies the exact layout and view incarnation that a callback may end.
type presentationJoin struct {
	ticket     uint64
	generation uint64
	abandon    func() error
}

// pendingPresentation holds placement state until the transaction's root-view joins end.
type pendingPresentation struct {
	placements map[string]presentationPlacement
	invalid    map[string]bool
	accepted   bool
}

// presentationWait holds each joined view, its accepted placement state, and placements of open layout tickets. It runs on the UI
// thread only.
type presentationWait struct {
	waiting   map[string]presentationJoin
	committed map[string]presentationPlacement
	pending   map[uint64]*pendingPresentation
}

// presentationEnds are reasons that end a presentation wait. Cancellation is separate because it aborts its layout transaction.
var presentationEnds = map[string]bool{"presented": true, "process-ended": true, "hidden": true, "unresponsive": true}

// prepare records the placements and returns the visible root views whose placement or generation changed.
func (w *presentationWait) prepare(ticket uint64, placements []Placement, generations map[string]uint64) []Placement {
	if w.pending == nil {
		w.pending = map[uint64]*pendingPresentation{}
	}
	state := &pendingPresentation{placements: map[string]presentationPlacement{}, invalid: map[string]bool{}}
	changed := make([]Placement, 0, len(placements))
	for _, placement := range placements {
		current := presentationPlacement{rect: placement.Rect, visible: placement.Visible, generation: generations[placement.ID]}
		state.placements[placement.ID] = current
		previous, exists := w.committed[placement.ID]
		if placement.Visible && (!exists || previous != current) {
			changed = append(changed, placement)
		}
	}
	w.pending[ticket] = state
	return changed
}

// accept records that the native layout accepted the ticket. It promotes placements immediately when the native transaction had no joins.
func (w *presentationWait) accept(ticket uint64) {
	if state := w.pending[ticket]; state != nil {
		state.accepted = true
		w.finishIfReady(ticket)
	}
}

// begin joins the view of surface to a ticket and generation. It reports false when the view already waits.
func (w *presentationWait) begin(surface string, abandon func() error) bool {
	return w.beginFor(surface, 0, 0, abandon)
}

func (w *presentationWait) beginFor(surface string, ticket, generation uint64, abandon func() error) bool {
	if w.waiting == nil {
		w.waiting = map[string]presentationJoin{}
	}
	if w.waits(surface) {
		return false
	}
	w.waiting[surface] = presentationJoin{ticket: ticket, generation: generation, abandon: abandon}
	return true
}

// waits reports whether the view of surface waits for its presentation.
func (w *presentationWait) waits(surface string) bool {
	_, ok := w.waiting[surface]
	return ok
}

// end ends the current wait of surface. It is used by lifecycle events for the current view.
func (w *presentationWait) end(surface, reason string) (bool, error) {
	return w.endFor(surface, 0, 0, reason)
}

// endFor ends a wait only when ticket and generation still identify that wait. Zero identifiers match the current wait for lifecycle events.
func (w *presentationWait) endFor(surface string, ticket, generation uint64, reason string) (bool, error) {
	if !presentationEnds[reason] {
		return false, fmt.Errorf("presentation wait ends with %q, which is not an end", reason)
	}
	join, waiting := w.waiting[surface]
	if !waiting || ticket != 0 && join.ticket != ticket || generation != 0 && join.generation != generation {
		return false, nil
	}
	delete(w.waiting, surface)
	if reason != "presented" {
		if state := w.pending[join.ticket]; state != nil {
			state.invalid[surface] = true
		}
	}
	w.finishIfReady(join.ticket)
	if reason == "presented" {
		return false, nil
	}
	EmitHost(LevelDebug, "host.trace.view.presentation-abandoned", map[string]any{"surface": surface, "reason": reason})
	if join.abandon != nil {
		if err := join.abandon(); err != nil {
			return true, fmt.Errorf("ending the native join of view %s: %w", surface, err)
		}
	}
	return true, nil
}

// cancelTicket abandons joins of an aborted native layout. It does not write a presentation-abandoned event because that ticket did not commit.
func (w *presentationWait) cancelTicket(ticket uint64) error {
	delete(w.pending, ticket)
	var failures []string
	for surface, join := range w.waiting {
		if join.ticket != ticket {
			continue
		}
		delete(w.waiting, surface)
		if join.abandon != nil {
			if err := join.abandon(); err != nil {
				failures = append(failures, fmt.Sprintf("view %s: %v", surface, err))
			}
		}
	}
	if len(failures) != 0 {
		return fmt.Errorf("abandoning presentation joins for layout %d: %s", ticket, failures)
	}
	return nil
}

// cancelAll abandons every open layout join before the native owner cancels its layout.
func (w *presentationWait) cancelAll() error {
	tickets := map[uint64]bool{}
	for ticket := range w.pending {
		tickets[ticket] = true
	}
	for _, join := range w.waiting {
		tickets[join.ticket] = true
	}
	var failures []string
	for ticket := range tickets {
		if err := w.cancelTicket(ticket); err != nil {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) != 0 {
		return fmt.Errorf("abandoning open presentation joins: %s", failures)
	}
	return nil
}

func (w *presentationWait) finishIfReady(ticket uint64) {
	state := w.pending[ticket]
	if state == nil || !state.accepted {
		return
	}
	for _, join := range w.waiting {
		if join.ticket == ticket {
			return
		}
	}
	if w.committed == nil {
		w.committed = map[string]presentationPlacement{}
	}
	for surface, placement := range state.placements {
		if state.invalid[surface] {
			delete(w.committed, surface)
			continue
		}
		w.committed[surface] = placement
	}
	delete(w.pending, ticket)
}

// joinViewsForPresentRequest attaches changed, newly shown, or recreated root views to the request's layout transaction.
func (s *Surfaces) joinViewsForPresentRequest(window unsafe.Pointer, req PresentRequest, placements []Placement) error {
	generations := make(map[string]uint64, len(placements))
	for _, placement := range placements {
		if view, ok := s.documents.view(placement.ID); ok {
			generations[placement.ID] = view.generation
		}
	}
	changed := s.presentation.prepare(req.Ticket, placements, generations)
	return s.joinShownViews(window, req.Ticket, changed)
}

// joinShownViews joins each changed shown root view that waits for no presentation yet to the open layout transaction of window.
func (s *Surfaces) joinShownViews(window unsafe.Pointer, ticket uint64, placements []Placement) error {
	for _, p := range placements {
		if !p.Visible || s.presentation.waits(p.ID) || s.viewRecords().specs[p.ID] == nil {
			continue
		}
		view, err := s.documents.Get(DocumentKey{Surface: p.ID, Name: viewRegionName})
		if err != nil {
			continue
		}
		channel, ok := s.documents.view(p.ID)
		if !ok {
			continue
		}
		surface, generation := p.ID, channel.generation
		abandon, joined, err := system.JoinView(window, ticket, view, func() {
			if err := system.EnqueueUI(func() { s.endPresentationWaitFor(surface, ticket, generation, "presented") }); err != nil {
				LogError("view channel", err)
			}
		})
		if err != nil {
			return fmt.Errorf("joining view %s to the layout transaction: %w", p.ID, err)
		}
		if !joined {
			continue
		}
		if !s.presentation.beginFor(surface, ticket, generation, abandon) {
			if err := abandon(); err != nil {
				return fmt.Errorf("view %s already waits and its extra native join could not be abandoned: %w", surface, err)
			}
			return fmt.Errorf("view %s joined the layout transaction while it already waits", surface)
		}
	}
	return nil
}

// endPresentationWait ends the current wait of surface and reports lifecycle abandonment to the page.
func (s *Surfaces) endPresentationWait(surface, reason string) {
	s.endPresentationWaitFor(surface, 0, 0, reason)
}

func (s *Surfaces) endPresentationWaitFor(surface string, ticket, generation uint64, reason string) {
	abandoned, err := s.presentation.endFor(surface, ticket, generation, reason)
	if err != nil {
		LogError("view channel", err)
	}
	if abandoned {
		s.emitToSurface(surface, "view-presentation-abandoned", map[string]any{"surface": surface, "reason": reason})
	}
}

// cancelLayoutPresentation abandons the ticket's joins before native cancellation, which does not invoke presentation callbacks.
func (s *Surfaces) cancelLayoutPresentation(window unsafe.Pointer, ticket uint64) error {
	var joinErr error
	if err := s.presentation.cancelTicket(ticket); err != nil {
		joinErr = err
	}
	if err := system.CancelLayoutTicket(window, ticket); err != nil {
		if joinErr != nil {
			return fmt.Errorf("%w; cancelling layout: %v", joinErr, err)
		}
		return err
	}
	return joinErr
}

// cancelAllLayoutPresentations abandons host waits before native cancellation of the window's open layout.
func (s *Surfaces) cancelAllLayoutPresentations(window unsafe.Pointer) error {
	joinErr := s.presentation.cancelAll()
	if err := system.CancelLayout(window); err != nil {
		if joinErr != nil {
			return fmt.Errorf("%w; cancelling layout: %v", joinErr, err)
		}
		return err
	}
	return joinErr
}
