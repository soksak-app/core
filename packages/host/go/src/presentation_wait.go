package host

import (
	"fmt"
	"strings"
	"sync"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
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
}

// presentationEnds are reasons that end a presentation wait. Cancellation is separate because it aborts its layout transaction.
// input is a press or key event that ended the hold, and closed is the close of the view, by the native view or by the close of the
// documents of its surface; no wait ends by time (docs/spec/native-surfaces.md#layout-transaction).
var presentationEnds = map[string]bool{"presented": true, "process-ended": true, "hidden": true, "unresponsive": true, "input": true, "closed": true}

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
// An end of the host abandons the native join of the wait.
func (w *presentationWait) endFor(surface string, ticket, generation uint64, reason string) (bool, error) {
	return w.finish(surface, ticket, generation, reason, false)
}

// endedNatively ends the wait that ticket and generation identify by an end that its native join reported of itself, which leaves
// no native join to abandon.
func (w *presentationWait) endedNatively(surface string, ticket, generation uint64, reason string) (bool, error) {
	return w.finish(surface, ticket, generation, reason, true)
}

func (w *presentationWait) finish(surface string, ticket, generation uint64, reason string, native bool) (bool, error) {
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
	tracePresentationJoin("abandoned", surface, join.generation, join.ticket, false, reason)
	EmitHost(LevelDebug, "host.trace.view.presentation-abandoned", map[string]any{"surface": surface, "reason": reason})
	// An end of the native join itself, an input that ended the hold or the native close of the view, leaves no native join to
	// abandon.
	if join.abandon != nil && !native {
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

// cancelTicket abandons joins of an aborted native layout. It removes every wait of the ticket before it abandons their native joins.
// It does not write a presentation-abandoned event because that ticket did not commit.
func (w *presentationWait) cancelTicket(ticket uint64) error {
	delete(w.pending, ticket)
	var failures []string
	for _, wait := range w.takeWaits(func(join presentationJoin) bool { return join.ticket == ticket }) {
		if wait.join.abandon == nil {
			continue
		}
		if err := wait.join.abandon(); err != nil {
			failures = append(failures, fmt.Sprintf("view %s: %v", wait.surface, err))
		}
	}
	if len(failures) != 0 {
		return fmt.Errorf("abandoning presentation joins for layout %d: %s", ticket, strings.Join(failures, "; "))
	}
	return nil
}

// cancelAll removes every open wait and pending layout before it abandons the native joins of the waits, which it does before the
// native owner cancels its layout.
func (w *presentationWait) cancelAll() error {
	w.pending = nil
	var failures []string
	for _, wait := range w.takeWaits(func(presentationJoin) bool { return true }) {
		if wait.join.abandon == nil {
			continue
		}
		if err := wait.join.abandon(); err != nil {
			failures = append(failures, fmt.Sprintf("layout %d, view %s: %v", wait.join.ticket, wait.surface, err))
		}
	}
	if len(failures) != 0 {
		return fmt.Errorf("abandoning presentation joins: %s", strings.Join(failures, "; "))
	}
	return nil
}

// takenWait is a wait that takeWaits removed, with the surface of its view.
type takenWait struct {
	surface string
	join    presentationJoin
}

// takeWaits removes the waits that match selects and returns them, so their native joins are abandoned with no wait of them left.
func (w *presentationWait) takeWaits(selects func(presentationJoin) bool) []takenWait {
	var taken []takenWait
	for surface, join := range w.waiting {
		if selects(join) {
			taken = append(taken, takenWait{surface: surface, join: join})
			delete(w.waiting, surface)
		}
	}
	return taken
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
func (s *Surfaces) joinViewsForPresentRequest(window platform.Window, req PresentRequest, placements []Placement) error {
	return s.joinShownViews(window, req.Ticket, s.presentationJoins(req, placements))
}

// presentationJoins records the placements of the request and returns the visible root views whose placement or generation changed.
func (s *Surfaces) presentationJoins(req PresentRequest, placements []Placement) []Placement {
	generations := make(map[string]uint64, len(placements))
	for _, placement := range placements {
		if view, ok := s.documents.view(placement.ID); ok {
			generations[placement.ID] = view.generation
		}
	}
	return s.presentation.prepare(req.Ticket, placements, generations)
}

// joinShownViews joins each changed shown root view that waits for no presentation yet to the open layout transaction of window.
func (s *Surfaces) joinShownViews(window platform.Window, ticket uint64, placements []Placement) error {
	for _, p := range s.joinablePlacements(placements) {
		if _, _, err := s.joinViewForPresentation(window, ticket, p); err != nil {
			return err
		}
	}
	return nil
}

// joinablePlacements returns the shown placements of root views that wait for no presentation yet.
func (s *Surfaces) joinablePlacements(placements []Placement) []Placement {
	var joinable []Placement
	for _, p := range placements {
		if !p.Visible || s.presentation.waits(p.ID) || s.viewRecords().specs[p.ID] == nil {
			continue
		}
		joinable = append(joinable, p)
	}
	return joinable
}

// viewJoinRequest is the join of one root view to a layout transaction as the native layer receives it: the window, the ticket, the
// view and the two receivers of the native join, which the native layer calls outside the UI thread. signal is the one that the
// presentation of the join completes.
type viewJoinRequest struct {
	window     platform.Window
	ticket     uint64
	view       unsafe.Pointer
	surface    string
	generation uint64
	signal     *presentationSignal
	presented  func()
	ended      func(reason string)
}

// viewJoinAnswer is the answer of the native layer to a join: the function that abandons the native join, whether the view joined, and
// the failure.
type viewJoinAnswer struct {
	abandon func() error
	joined  bool
	err     error
}

// joinViewForPresentation joins the root view of placement to the open transaction of window.
func (s *Surfaces) joinViewForPresentation(window platform.Window, ticket uint64, placement Placement) (uint64, bool, error) {
	request, ok := s.requestViewJoin(window, ticket, placement)
	if !ok {
		return 0, false, nil
	}
	abandon, joined, err := system.JoinView(request.window, request.ticket, request.view, request.presented, request.ended)
	return s.viewJoined(request, viewJoinAnswer{abandon: abandon, joined: joined, err: err})
}

// requestViewJoin returns the join of the root view of placement to the transaction ticket, and false for a surface without a view.
func (s *Surfaces) requestViewJoin(window platform.Window, ticket uint64, placement Placement) (viewJoinRequest, bool) {
	view, err := s.documents.Get(DocumentKey{Surface: placement.ID, Name: viewRegionName})
	if err != nil {
		return viewJoinRequest{}, false
	}
	channel, ok := s.documents.view(placement.ID)
	if !ok {
		return viewJoinRequest{}, false
	}
	request := viewJoinRequest{
		window: window, ticket: ticket, view: view, surface: placement.ID, generation: channel.generation, signal: &presentationSignal{},
	}
	tracePresentationJoin("requested", request.surface, request.generation, ticket, false, "")
	request.presented = func() {
		s.viewJoinPresented(request)
		if err := system.EnqueueUI(func() { s.endPresentationWaitFor(request.surface, ticket, request.generation, "presented") }); err != nil {
			LogError("view channel", err)
		}
	}
	request.ended = func(reason string) {
		if err := system.EnqueueUI(func() { s.viewJoinEnded(request, reason) }); err != nil {
			LogError("view channel", err)
		}
	}
	return request, true
}

// viewJoinPresented records that the native presentation of the join completed. The native layer reports it outside the UI thread, and
// it can run before the join returned.
func (s *Surfaces) viewJoinPresented(request viewJoinRequest) {
	tracePresentationJoin("presented", request.surface, request.generation, request.ticket, false, "")
	request.signal.complete()
}

// viewJoinEnded ends the wait of the join by an end that the native join reported of itself, by a press or key event that ended the
// hold or by the close of the view, so the end abandons no native join. It runs on the UI thread.
func (s *Surfaces) viewJoinEnded(request viewJoinRequest, reason string) {
	s.endNativePresentationWait(request.surface, request.ticket, request.generation, reason)
}

// viewJoined records the answer of the native layer to the join of request and returns the generation of the view and whether it joined.
func (s *Surfaces) viewJoined(request viewJoinRequest, answer viewJoinAnswer) (uint64, bool, error) {
	surface, generation, ticket := request.surface, request.generation, request.ticket
	tracePresentationJoin("result", surface, generation, ticket, answer.err == nil && answer.joined, "")
	if answer.err != nil {
		return generation, false, fmt.Errorf("joining view %s to the layout transaction: %w", surface, answer.err)
	}
	if !answer.joined {
		return generation, false, nil
	}
	if !s.presentation.beginFor(surface, ticket, generation, request.signal, answer.abandon) {
		if err := answer.abandon(); err != nil {
			return generation, false, fmt.Errorf("view %s already waits and its extra native join could not be abandoned: %w", surface, err)
		}
		return generation, false, fmt.Errorf("view %s joined the layout transaction while it already waits", surface)
	}
	if state := s.presentation.pending[ticket]; state != nil {
		state.joined[surface] = generation
	}
	// WebKit reports a page process unresponsive only after input or a load, so a visible view whose process stops before it
	// presents sends no end; the next press or key event of the user ends the hold and the join with it, and no wait ends by time
	// (docs/spec/native-surfaces.md#layout-transaction).
	return generation, true, nil
}

// endPresentationWait ends the current wait of surface and reports lifecycle abandonment to the page.
func (s *Surfaces) endPresentationWait(surface, reason string) {
	s.endPresentationWaitFor(surface, 0, 0, reason)
}

func (s *Surfaces) endPresentationWaitFor(surface string, ticket, generation uint64, reason string) {
	abandoned, err := s.presentation.endFor(surface, ticket, generation, reason)
	s.presentationWaitEnded(surface, reason, abandoned, err)
}

// endNativePresentationWait ends the wait that ticket and generation identify by an end that its native join reported of itself.
func (s *Surfaces) endNativePresentationWait(surface string, ticket, generation uint64, reason string) {
	abandoned, err := s.presentation.endedNatively(surface, ticket, generation, reason)
	s.presentationWaitEnded(surface, reason, abandoned, err)
}

// presentationWaitEnded reports the end of a presentation wait: an error of the end and the abandonment to the page.
func (s *Surfaces) presentationWaitEnded(surface, reason string, abandoned bool, err error) {
	if err != nil {
		LogError("view channel", err)
	}
	if abandoned {
		if reason == "input" {
			LogError("view presentation", fmt.Errorf("surface %s had not presented when input ended the hold", surface))
		}
		s.emitToSurface(surface, "view-presentation-abandoned", map[string]any{"surface": surface, "reason": reason})
	}
}

// cancelLayoutPresentation abandons the ticket's joins before native cancellation, which does not invoke presentation callbacks.
func (s *Surfaces) cancelLayoutPresentation(window platform.Window, ticket uint64) error {
	// The cancel of a ticket, a failed presentation among them, ends the run with its transaction
	// (docs/spec/native-surfaces.md#layout-transaction).
	s.run(false)
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
func (s *Surfaces) cancelAllLayoutPresentations(window platform.Window) error {
	s.run(false)
	joinErr := s.presentation.cancelAll()
	if err := system.CancelLayout(window); err != nil {
		if joinErr != nil {
			return fmt.Errorf("%w; cancelling layout: %v", joinErr, err)
		}
		return err
	}
	return joinErr
}
