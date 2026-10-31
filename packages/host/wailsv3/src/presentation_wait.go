package host

import (
	"fmt"
	"sync"
	"unsafe"
)

// presentationPlacement is the last accepted placement of one plugin root view.
type presentationPlacement struct {
	rect       Rect
	visible    bool
	generation uint64
}

// presentationSignal records that the native presentation of one join completed. The presentation callback sets it when the view
// presents, which can run before the UI thread processes the end, so it holds a lock.
type presentationSignal struct {
	mu        sync.Mutex
	presented bool
}

// complete records the presentation of the join.
func (s *presentationSignal) complete() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.presented = true
}

// completed reports whether the presentation of the join completed.
func (s *presentationSignal) completed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.presented
}

// presentationJoin identifies the exact layout and view incarnation that a callback may end.
type presentationJoin struct {
	ticket     uint64
	generation uint64
	presented  *presentationSignal
	abandon    func() error
}

// pendingPresentation holds placement state until the transaction's root-view joins end.
type pendingPresentation struct {
	placements   map[string]presentationPlacement
	requiresJoin map[string]bool
	joined       map[string]uint64
	invalid      map[string]bool
	accepted     bool
}

// presentationWait holds each joined view, its accepted placement state, and placements of open layout tickets. It runs on the UI
// thread only.
type presentationWait struct {
	waiting   map[string]presentationJoin
	committed map[string]presentationPlacement
	pending   map[uint64]*pendingPresentation
	// timedOut holds, for each surface, the view generation whose wait ended at the presentation limit. That generation joins no
	// later wait, so a view that does not present holds no later transaction for the limit again.
	timedOut map[string]uint64
}

// presentationEnds are reasons that end a presentation wait. Cancellation is separate because it aborts its layout transaction.
var presentationEnds = map[string]bool{"presented": true, "process-ended": true, "hidden": true, "unresponsive": true, "timeout": true}

// prepare records the placements and returns the visible root views whose placement or generation changed.
func (w *presentationWait) prepare(ticket uint64, placements []Placement, generations map[string]uint64) []Placement {
	if w.pending == nil {
		w.pending = map[uint64]*pendingPresentation{}
	}
	state := &pendingPresentation{
		placements: map[string]presentationPlacement{}, requiresJoin: map[string]bool{}, joined: map[string]uint64{}, invalid: map[string]bool{},
	}
	changed := make([]Placement, 0, len(placements))
	for _, placement := range placements {
		current := presentationPlacement{rect: placement.Rect, visible: placement.Visible, generation: generations[placement.ID]}
		state.placements[placement.ID] = current
		previous, exists := w.committed[placement.ID]
		if placement.Visible && (!exists || previous != current) {
			changed = append(changed, placement)
			state.requiresJoin[placement.ID] = true
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
	return w.beginFor(surface, 0, 0, &presentationSignal{}, abandon)
}

// beginFor joins the view of surface to a ticket and generation. The presented signal is the one that the presentation callback of the
// join completes.
func (w *presentationWait) beginFor(surface string, ticket, generation uint64, presented *presentationSignal, abandon func() error) bool {
	if w.waiting == nil {
		w.waiting = map[string]presentationJoin{}
	}
	if w.waits(surface) {
		return false
	}
	w.waiting[surface] = presentationJoin{ticket: ticket, generation: generation, presented: presented, abandon: abandon}
	return true
}

// waitsFor reports whether the current wait of surface is the join that ticket and generation identify.
func (w *presentationWait) waitsFor(surface string, ticket, generation uint64) bool {
	join, ok := w.waiting[surface]
	return ok && join.ticket == ticket && join.generation == generation
}

// endedAtLimit reports whether the wait of generation of surface ended at the presentation limit.
func (w *presentationWait) endedAtLimit(surface string, generation uint64) bool {
	ended, ok := w.timedOut[surface]
	return ok && ended == generation
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
	if waiting && (ticket != 0 && join.ticket != ticket || generation != 0 && join.generation != generation) {
		return false, nil
	}
	if waiting {
		delete(w.waiting, surface)
	}
	if reason != "presented" {
		if waiting {
			if state := w.pending[join.ticket]; state != nil {
				state.invalid[surface] = true
			}
		}
		if generation != 0 {
			for pendingTicket, state := range w.pending {
				if ticket != 0 && pendingTicket != ticket {
					continue
				}
				placement, exists := state.placements[surface]
				if exists && placement.generation == generation {
					state.invalid[surface] = true
					w.finishIfReady(pendingTicket)
				}
			}
		}
	}
	if waiting {
		w.finishIfReady(join.ticket)
	}
	if reason == "presented" || !waiting {
		return false, nil
	}
	// The presentation callback completes the join before its end is queued to the UI thread, so an end that runs first ends the
	// wait as presented: it writes no abandoned record and abandons no native join.
	if join.presented.completed() {
		return false, nil
	}
	if reason == "timeout" {
		if w.timedOut == nil {
			w.timedOut = map[string]uint64{}
		}
		w.timedOut[surface] = join.generation
	}
	tracePresentationJoin("abandoned", surface, join.generation, join.ticket, false, reason)
	EmitHost(LevelDebug, "host.trace.view.presentation-abandoned", map[string]any{"surface": surface, "reason": reason})
	if join.abandon != nil {
		if err := join.abandon(); err != nil {
			return true, fmt.Errorf("ending the native join of view %s: %w", surface, err)
		}
	}
	return true, nil
}

// tracePresentationJoin records one root-view join phase only while the performance trace and its event gate are enabled.
func tracePresentationJoin(phase, surface string, generation, ticket uint64, joined bool, reason string) {
	if !PerformanceEnabled() || !GateEvent(ClassCall, LevelDebug) {
		return
	}
	fields := map[string]any{
		"phase":      phase,
		"surface":    surface,
		"generation": generation,
		"ticket":     ticket,
	}
	if phase == "result" {
		fields["joined"] = joined
	}
	if phase == "abandoned" {
		fields["reason"] = reason
	}
	EmitHost(LevelDebug, "host.trace.view.presentation-join", fields)
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
		if channel, ok := s.documents.view(p.ID); ok && s.presentation.endedAtLimit(p.ID, channel.generation) {
			continue
		}
		if _, _, err := s.joinViewForPresentation(window, ticket, p); err != nil {
			return err
		}
	}
	return nil
}

func (s *Surfaces) joinViewForPresentation(window unsafe.Pointer, ticket uint64, placement Placement) (uint64, bool, error) {
	view, err := s.documents.Get(DocumentKey{Surface: placement.ID, Name: viewRegionName})
	if err != nil {
		return 0, false, nil
	}
	channel, ok := s.documents.view(placement.ID)
	if !ok {
		return 0, false, nil
	}
	surface, generation := placement.ID, channel.generation
	tracePresentationJoin("requested", surface, generation, ticket, false, "")
	presented := &presentationSignal{}
	abandon, joined, err := system.JoinView(window, ticket, view, func() {
		tracePresentationJoin("presented", surface, generation, ticket, false, "")
		presented.complete()
		if err := system.EnqueueUI(func() { s.endPresentationWaitFor(surface, ticket, generation, "presented") }); err != nil {
			LogError("view channel", err)
		}
	})
	tracePresentationJoin("result", surface, generation, ticket, err == nil && joined, "")
	if err != nil {
		return generation, false, fmt.Errorf("joining view %s to the layout transaction: %w", surface, err)
	}
	if !joined {
		return generation, false, nil
	}
	if !s.presentation.beginFor(surface, ticket, generation, presented, abandon) {
		if err := abandon(); err != nil {
			return generation, false, fmt.Errorf("view %s already waits and its extra native join could not be abandoned: %w", surface, err)
		}
		return generation, false, fmt.Errorf("view %s joined the layout transaction while it already waits", surface)
	}
	if state := s.presentation.pending[ticket]; state != nil {
		state.joined[surface] = generation
	}
	// WebKit reports a page process unresponsive only after input or a load, so a visible view whose process stops before it presents
	// sends no end; the limit ends its wait (docs/spec/native-surfaces.md#view-surfaces).
	if err := system.EnqueueUIAfter(pageTimeout, func() { s.endPresentationWaitAtLimit(surface, ticket, generation) }); err != nil {
		return generation, true, fmt.Errorf("arming the presentation limit of view %s: %w", surface, err)
	}
	return generation, true, nil
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
		if reason == "timeout" {
			LogError("view presentation", fmt.Errorf("surface %s did not present within %s", surface, pageTimeout))
		}
		s.emitToSurface(surface, "view-presentation-abandoned", map[string]any{"surface": surface, "reason": reason})
	}
}

// endPresentationWaitAtLimit ends the wait of the join that ticket and generation identify at the presentation limit. A limit
// whose join already ended changes nothing, because its end would invalidate a placement of a later state.
func (s *Surfaces) endPresentationWaitAtLimit(surface string, ticket, generation uint64) {
	if s.presentation.waitsFor(surface, ticket, generation) {
		s.endPresentationWaitFor(surface, ticket, generation, "timeout")
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
