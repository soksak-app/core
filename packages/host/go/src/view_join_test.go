package host

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

const presentationJoinTrace = "host.trace.view.presentation-join"

// viewJoins lists the joins of root views to layout transactions that a test gave the answer of the native layer, in order, with the
// number of the abandons of each native join. inputEnded holds the tickets whose transaction a press or key event ended, which the
// native layer joins no view to.
type viewJoins struct {
	requests   []viewJoinRequest
	abandons   []int
	inputEnded map[uint64]bool
}

// join answers the join request as the native layer answers a join of a view to an open transaction, and records the host state with
// it (viewJoined).
func (j *viewJoins) join(s *Surfaces, request viewJoinRequest) (uint64, bool, error) {
	if j.inputEnded[request.ticket] {
		return s.viewJoined(request, viewJoinAnswer{})
	}
	index := len(j.requests)
	j.requests = append(j.requests, request)
	j.abandons = append(j.abandons, 0)
	return s.viewJoined(request, viewJoinAnswer{joined: true, abandon: func() error {
		j.abandons[index]++
		return nil
	}})
}

// forRequest joins the views that the present request attaches to its transaction (joinViewsForPresentRequest).
func (j *viewJoins) forRequest(s *Surfaces, window platform.Window, req PresentRequest, placements []Placement) error {
	return j.shown(s, window, req.Ticket, s.presentationJoins(req, placements))
}

// shown joins the shown root views that wait for no presentation yet to the open transaction (joinShownViews).
func (j *viewJoins) shown(s *Surfaces, window platform.Window, ticket uint64, placements []Placement) error {
	for _, placement := range s.joinablePlacements(placements) {
		request, ok := s.requestViewJoin(window, ticket, placement)
		if !ok {
			continue
		}
		if _, _, err := j.join(s, request); err != nil {
			return err
		}
	}
	return nil
}

// ensure checks the joins of the request and joins the views that need it (ensureCurrentPresentationJoins).
func (j *viewJoins) ensure(s *Surfaces, window platform.Window, req PresentRequest) error {
	requests, err := s.rejoinRequests(window, req)
	if err != nil {
		return err
	}
	for _, request := range requests {
		if _, _, err := j.join(s, request); err != nil {
			return err
		}
	}
	return nil
}

// present delivers the presentation of the join number index: the native receiver runs, and the task that it queues runs on the UI thread.
func (j *viewJoins) present(s *Surfaces, index int) {
	request := j.requests[index]
	s.viewJoinPresented(request)
	s.endPresentationWaitFor(request.surface, request.ticket, request.generation, "presented")
}

// end delivers the end that the native join number index reports of itself, and the task that it queues runs on the UI thread.
func (j *viewJoins) end(s *Surfaces, index int, reason string) {
	s.viewJoinEnded(j.requests[index], reason)
}

// contract: view.presentation-wait.joins
func TestUnsettledChangedRootPlacementJoinsItsPresentation(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	window := platform.Window(1)
	placements := []Placement{{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}}
	request := PresentRequest{Ticket: 23, Placements: placements, Settled: false}
	if err := joins.forRequest(s, window, request, placements); err != nil {
		t.Fatalf("join changed placement: %v", err)
	}
	if len(joins.requests) != 1 {
		t.Fatalf("unsettled changed root placement joined %d views, want 1", len(joins.requests))
	}
	if joins.requests[0].ticket != request.Ticket || joins.requests[0].view != views.created[0] {
		t.Fatalf("join ticket/view are %d/%p, want %d/%p", joins.requests[0].ticket, joins.requests[0].view, request.Ticket, views.created[0])
	}
}

// contract: surface-layout.joins-root-views-before-awaiting-app-dom
func TestProcessEndedRootIsRejoinedOnItsOpenTicketBeforeCommit(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	window := platform.Window(1)
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	request := PresentRequest{Ticket: 36, Placements: []Placement{placement}, Settled: false}
	if err := joins.forRequest(s, window, request, request.Placements); err != nil {
		t.Fatalf("join initial generation: %v", err)
	}
	old, ok := s.documents.view(placement.ID)
	if !ok {
		t.Fatal("initial root view channel is missing")
	}
	if _, err := s.documents.Remove(DocumentKey{Surface: placement.ID, Name: viewRegionName}); err != nil {
		t.Fatalf("remove ended root document: %v", err)
	}
	s.endPresentationWaitFor(placement.ID, request.Ticket, old.generation, "process-ended")

	replacementGeneration := old.generation + 1
	replacementRoot := unsafe.Pointer(new(int))
	s.documents.registerView(placement.ID, "probe", replacementGeneration, replacementRoot)
	key := DocumentKey{Surface: placement.ID, Name: viewRegionName}
	if err := s.documents.Reserve(key); err != nil {
		t.Fatalf("reserve replacement root document: %v", err)
	}
	if !s.documents.Set(key, replacementRoot) {
		t.Fatal("replacement root document was not registered")
	}
	if err := joins.ensure(s, window, request); err != nil {
		t.Fatalf("recheck presentation generation: %v", err)
	}
	if len(joins.requests) != 2 || joins.requests[1].ticket != request.Ticket || joins.requests[1].view != replacementRoot {
		t.Fatalf("same-ticket joins are %+v; want generation %d joined to ticket %d before commit", joins.requests, replacementGeneration, request.Ticket)
	}
}

// A press or key event that ends the transaction while the presentation waits commits what the joined views presented, so a
// generation that replaced a root view meanwhile joins nothing and the commit of the ticket answers the committed state
// (docs/spec/native-surfaces.md#layout-transaction).
// contract: surface-layout.input-ended-ticket-joins-no-replaced-root
func TestAReplacedRootOfATransactionThatInputEndedJoinsNothingAndDoesNotFailTheCommit(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	window := platform.Window(1)
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	request := PresentRequest{Ticket: 38, Placements: []Placement{placement}, Settled: false}
	if err := joins.forRequest(s, window, request, request.Placements); err != nil {
		t.Fatalf("join initial generation: %v", err)
	}
	old, ok := s.documents.view(placement.ID)
	if !ok {
		t.Fatal("initial root view channel is missing")
	}
	if _, err := s.documents.Remove(DocumentKey{Surface: placement.ID, Name: viewRegionName}); err != nil {
		t.Fatalf("remove ended root document: %v", err)
	}
	s.endPresentationWaitFor(placement.ID, request.Ticket, old.generation, "input")
	replacementRoot := unsafe.Pointer(new(int))
	s.documents.registerView(placement.ID, "probe", old.generation+1, replacementRoot)
	key := DocumentKey{Surface: placement.ID, Name: viewRegionName}
	if err := s.documents.Reserve(key); err != nil {
		t.Fatalf("reserve replacement root document: %v", err)
	}
	if !s.documents.Set(key, replacementRoot) {
		t.Fatal("replacement root document was not registered")
	}
	joins.inputEnded = map[uint64]bool{request.Ticket: true}
	if err := joins.ensure(s, window, request); err != nil {
		t.Fatalf("a replaced root of a transaction that input ended failed the commit: %v", err)
	}
	if len(joins.requests) != 1 {
		t.Fatalf("joins are %+v; want only the join of the initial generation", joins.requests)
	}
}

// contract: surface-layout.joins-root-views-before-awaiting-app-dom
func TestRestartLimitLeavesNoReplacementGenerationToJoin(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	window := platform.Window(1)
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	request := PresentRequest{Ticket: 37, Placements: []Placement{placement}, Settled: false}
	if err := joins.forRequest(s, window, request, request.Placements); err != nil {
		t.Fatalf("join initial generation: %v", err)
	}
	initial, ok := s.documents.view(placement.ID)
	if !ok {
		t.Fatal("initial root view channel is missing")
	}
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second, 30 * time.Second} {
		endView(t, s, views, viewTestEpoch.Add(offset))
	}
	if !s.viewRecords().isStopped(placement.ID) {
		t.Fatal("the fourth process end did not stop the view restart")
	}
	if _, ok := s.documents.view(placement.ID); ok {
		t.Fatal("a replacement view exists after the restart limit")
	}
	if err := joins.ensure(s, window, request); err != nil {
		t.Fatalf("the stopped view blocked its open layout: %v", err)
	}
	state := s.presentation.pending[request.Ticket]
	if !state.invalid[placement.ID] || state.placements[placement.ID].generation != initial.generation {
		t.Fatalf("stopped view pending state = %+v; want invalid old generation and no replacement", state)
	}
}

// contract: surface-layout.joins-root-views-before-awaiting-app-dom
func TestRestartLimitInvalidatesPlacementAfterItsJoinPresented(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	events := recordWindowEvents(s)
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second} {
		endView(t, s, views, viewTestEpoch.Add(offset))
	}
	window := platform.Window(1)
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	request := PresentRequest{Ticket: 39, Placements: []Placement{placement}, Settled: false}
	if err := joins.forRequest(s, window, request, request.Placements); err != nil {
		t.Fatalf("join current generation: %v", err)
	}
	current, ok := s.documents.view(placement.ID)
	if !ok {
		t.Fatal("current root generation is missing before its presentation")
	}
	joins.present(s, len(joins.requests)-1)
	if joins.abandons[len(joins.abandons)-1] != 0 {
		t.Fatal("a presented join was abandoned")
	}
	endView(t, s, views, viewTestEpoch.Add(30*time.Second))
	if !s.viewRecords().isStopped(placement.ID) {
		t.Fatal("the fourth process end did not stop the view restart")
	}
	if _, ok := s.documents.view(placement.ID); ok {
		t.Fatal("a replacement root exists after the restart limit")
	}
	if err := joins.ensure(s, window, request); err != nil {
		t.Fatalf("the stopped view blocked its open layout after its join presented: %v", err)
	}
	for _, event := range *events {
		if event.name == "view-presentation-abandoned" {
			t.Fatalf("a previously presented join emitted an abandonment event: %+v", event)
		}
	}
	state := s.presentation.pending[request.Ticket]
	if !state.invalid[placement.ID] || state.placements[placement.ID].generation != current.generation {
		t.Fatalf("pending placement after the stopped generation ended = %+v; want its presented generation invalidated", state)
	}
}

// contract: surface-layout.joins-root-views-before-awaiting-app-dom
func TestInitiallyAbsentRootGenerationIsNotPromoted(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	window := platform.Window(1)
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	if _, err := s.documents.Remove(DocumentKey{Surface: placement.ID, Name: viewRegionName}); err != nil {
		t.Fatalf("remove initial root document: %v", err)
	}
	request := PresentRequest{Ticket: 38, Placements: []Placement{placement}, Settled: false}
	if err := joins.forRequest(s, window, request, request.Placements); err != nil {
		t.Fatalf("prepare placement without an initial root generation: %v", err)
	}
	if err := joins.ensure(s, window, request); err != nil {
		t.Fatalf("an absent initial root generation blocked its open layout: %v", err)
	}
	state := s.presentation.pending[request.Ticket]
	if !state.invalid[placement.ID] || state.placements[placement.ID].generation != 0 || state.joined[placement.ID] != 0 {
		t.Fatalf("absent initial generation was promoted: %+v", state)
	}
}

// contract: view.presentation-wait.joins
func TestChangedPlacementJoinTracksCommittedGeometryVisibilityAndGeneration(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	root := views.created[0]
	child := unsafe.Pointer(new(int))
	childKey := DocumentKey{Surface: "probe-surface", Name: "studio"}
	if err := s.documents.Reserve(childKey); err != nil || !s.documents.Set(childKey, child) {
		t.Fatalf("register nested document: reserve error %v", err)
	}
	window := platform.Window(1)
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	request := func(ticket uint64, p Placement) PresentRequest {
		return PresentRequest{Ticket: ticket, Placements: []Placement{p}, Settled: false}
	}
	join := func(req PresentRequest, p Placement) {
		t.Helper()
		if err := joins.forRequest(s, window, req, []Placement{p}); err != nil {
			t.Fatalf("join ticket %d: %v", req.Ticket, err)
		}
	}
	complete := func(ticket uint64) {
		t.Helper()
		s.presentation.accept(ticket)
		joins.present(s, len(joins.requests)-1)
	}

	first := request(30, placement)
	join(first, placement)
	if len(joins.requests) != 1 || joins.requests[0].view != root || joins.requests[0].view == child {
		t.Fatalf("first join targets %v; want only root view %p, not nested document %p", joins.requests, root, child)
	}
	complete(first.Ticket)

	unchanged := request(31, placement)
	join(unchanged, placement)
	if len(joins.requests) != 1 {
		t.Fatalf("unchanged placement added a join; total joins %d, want 1", len(joins.requests))
	}
	s.presentation.accept(unchanged.Ticket)

	placement.Rect.W = 321
	changed := request(32, placement)
	join(changed, placement)
	if len(joins.requests) != 2 || joins.requests[1].ticket != changed.Ticket {
		t.Fatalf("changed placement joins %v; want one join for ticket %d", joins.requests, changed.Ticket)
	}
	complete(changed.Ticket)

	placement.Visible = false
	hidden := request(33, placement)
	join(hidden, placement)
	if len(joins.requests) != 2 {
		t.Fatalf("hidden placement added a join; total joins %d, want 2", len(joins.requests))
	}
	s.presentation.accept(hidden.Ticket)

	placement.Visible = true
	shown := request(34, placement)
	join(shown, placement)
	if len(joins.requests) != 3 || joins.requests[2].ticket != shown.Ticket {
		t.Fatalf("newly shown placement joins %v; want one join for ticket %d", joins.requests, shown.Ticket)
	}
	complete(shown.Ticket)

	channel, ok := s.documents.view("probe-surface")
	if !ok {
		t.Fatal("root view channel disappeared")
	}
	recreatedGeneration := channel.generation + 1
	recreatedRoot := unsafe.Pointer(new(int))
	s.documents.registerView("probe-surface", "probe", recreatedGeneration, recreatedRoot)
	if !s.documents.Set(DocumentKey{Surface: "probe-surface", Name: viewRegionName}, recreatedRoot) {
		t.Fatal("recreated root view document was not registered")
	}
	recreated := request(35, placement)
	join(recreated, placement)
	if len(joins.requests) != 4 || joins.requests[3].ticket != recreated.Ticket || joins.requests[3].view != recreatedRoot {
		t.Fatalf("recreated generation joins %v; want root view %p for ticket %d", joins.requests, recreatedRoot, recreated.Ticket)
	}
}

// contract: view.presentation-wait.joins
func TestOlderViewPresentationCannotEndANewerJoin(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	window := platform.Window(1)
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 1, Y: 2, W: 300, H: 160}, Visible: true}
	first := PresentRequest{Ticket: 40, Placements: []Placement{placement}}
	if err := joins.forRequest(s, window, first, []Placement{placement}); err != nil {
		t.Fatalf("join first ticket: %v", err)
	}
	s.presentation.accept(first.Ticket)
	channel, ok := s.documents.view(placement.ID)
	if !ok {
		t.Fatal("root view channel is missing")
	}
	s.endPresentationWaitFor(placement.ID, first.Ticket, channel.generation, "hidden")

	placement.Rect.X = 8
	second := PresentRequest{Ticket: 41, Placements: []Placement{placement}}
	if err := joins.forRequest(s, window, second, []Placement{placement}); err != nil {
		t.Fatalf("join second ticket: %v", err)
	}
	s.presentation.accept(second.Ticket)
	joins.present(s, 0)
	if !s.presentation.waits(placement.ID) {
		t.Fatal("the first ticket's late callback ended the newer presentation wait")
	}
	joins.present(s, 1)
	if s.presentation.waits(placement.ID) {
		t.Fatal("the current ticket's callback did not end its presentation wait")
	}
}

// realJoinSurfaces returns the surfaces of the view of the test surface, whose document is a web view of the real platform in a window
// of the real platform, with that window. The platform of the operating system is the platform of the host for the test, and the window
// and its web view close with the test. The layout transaction of the window ends with the test, so that no transaction stays open.
func realJoinSurfaces(t *testing.T) (*Surfaces, platform.Window) {
	t.Helper()
	useCurrentPlatformForViews(t)
	window := support.WindowWithMainPage(t, runOnMainThread, 320, 200, "main-page.html")
	var view unsafe.Pointer
	var err error
	runOnMainThread(func() {
		view, err = system.CreateWebview(window, platform.WebviewOptions{Identifier: 1, Name: "probe-view", Width: 300, Height: 160})
	})
	if err != nil {
		t.Fatalf("create the web view of the probe view: %v", err)
	}
	t.Cleanup(func() { runOnMainThread(func() { system.CloseWebview(view) }) })
	// A web view without a web process presents at once, and a joined view that presents at once never holds a commit. The page that
	// the view navigates to starts its process.
	var navigated bool
	runOnMainThread(func() { navigated = system.NavigateWebview(view, "main-page.html") })
	if !navigated {
		t.Fatal("the web view of the probe view did not start its navigation")
	}
	t.Cleanup(func() {
		runOnMainThread(func() {
			if err := system.CancelLayout(window); err != nil {
				t.Errorf("end the layout transaction of the window: %v", err)
			}
		})
	})
	s, _, _ := newLifecycleSurfacesOn(t, nullOriginStart(), view)
	return s, window
}

// beginLayout begins the layout transaction of ticket on window and returns the answers of the native layer to it, in order: true for a
// preparation that started and false for one that the native layer refused. The native layer answers on the main thread, at once for a
// window without a transaction that waits, and later for a preparation that waits for the commit of the open transaction. It runs on
// the main thread.
func beginLayout(window platform.Window, ticket uint64) (*[]bool, error) {
	answers := &[]bool{}
	err := system.BeginLayout(window, ticket, func(allowed bool) { *answers = append(*answers, allowed) })
	return answers, err
}

// commitLayout commits the layout of ticket on window from a goroutine of the test and returns whether the native layer took the commit: it
// takes the commit of the ticket of the open layout of the window and refuses the commit of another ticket.
func commitLayout(window platform.Window, ticket uint64) bool {
	var committed bool
	runOnMainThread(func() { committed = system.CommitLayout(window, ticket) })
	return committed
}

// The native layer presents a joined view in a later turn of the main run loop, so a test that judges the state of a transaction while
// its view has not presented runs its steps in one step of the main thread: the presentation of the view cannot arrive in it.

// contract: view.presentation-wait.cancel-clears-ticket, surface-layout.page-cancels-preparation
// The cancel of a ticket abandons the native join of its view before it cancels the native transaction of that ticket and no other: the
// commit of the cancelled ticket waits for the joined view, the preparation that waits behind that commit starts when the cancel ended
// the transaction and is not refused, and the host reports no presentation abandonment.
func TestLayoutCancellationClearsItsJoinWithoutPresentationAbandonment(t *testing.T) {
	s, window := realJoinSurfaces(t)
	events := recordWindowEvents(s)
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 1, Y: 2, W: 300, H: 160}, Visible: true}
	request := PresentRequest{Ticket: 42, Placements: []Placement{placement}}
	var failure string
	runOnMainThread(func() {
		first, err := beginLayout(window, request.Ticket)
		if err != nil || !slices.Equal(*first, []bool{true}) {
			failure = fmt.Sprintf("the native layer answered the preparation of ticket 42 with %v, %v, want it started", *first, err)
			return
		}
		if err := s.joinViewsForPresentRequest(window, request, request.Placements); err != nil {
			failure = fmt.Sprintf("join canceled ticket: %v", err)
			return
		}
		if !s.presentation.waits(placement.ID) {
			failure = "the view did not join the transaction of ticket 42"
			return
		}
		if !system.CommitLayout(window, request.Ticket) {
			failure = "the commit of ticket 42 was refused, want it deferred until the joined view presents"
			return
		}
		later, err := beginLayout(window, 43)
		if err != nil || len(*later) != 0 {
			failure = fmt.Sprintf("the preparation of ticket 43 was answered %v, %v while the commit of ticket 42 waits", *later, err)
			return
		}
		s.presentation.accept(request.Ticket)
		if err := s.cancelLayoutPresentation(window, request.Ticket); err != nil {
			failure = fmt.Sprintf("cancel layout: %v", err)
			return
		}
		if s.presentation.waits(placement.ID) || len(s.presentation.pending) != 0 {
			failure = fmt.Sprintf("canceled ticket left wait or pending state: waits=%v pending=%v", s.presentation.waiting, s.presentation.pending)
			return
		}
		if !slices.Equal(*later, []bool{true}) {
			failure = fmt.Sprintf("the cancel of ticket 42 left the preparation of ticket 43 answered %v, want it started and not refused", *later)
			return
		}
		if system.CommitLayout(window, request.Ticket) {
			failure = "the native layer took the commit of ticket 42 after its cancel"
			return
		}
		if !system.CommitLayout(window, 43) {
			failure = "the native layer refused the commit of ticket 43, which the cancel of ticket 42 left open"
			return
		}
		for _, event := range *events {
			if event.name == "view-presentation-abandoned" {
				failure = "layout cancellation reported presentation abandonment"
				return
			}
		}
		s.endPresentationWaitFor(placement.ID, request.Ticket, probeGeneration(s), "presented")
		if s.presentation.waits(placement.ID) {
			failure = "late callback from a canceled ticket restored or ended a wait"
		}
	})
	if failure != "" {
		t.Fatal(failure)
	}
}

// contract: surface-layout.cancelled-ticket-is-no-longer-current
// A reload cancels every open layout ticket while a presentation of one waits for the documents, and that presentation then answers
// that its preparation is no longer current, as the native commit of a cancelled ticket answers on every host.
func TestAPresentationWhoseTicketAReloadCancelledIsNoLongerCurrent(t *testing.T) {
	s, window := realJoinSurfaces(t)
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 1, Y: 2, W: 300, H: 160}, Visible: true}
	request := PresentRequest{Ticket: 9, Placements: []Placement{placement}}
	var failure string
	runOnMainThread(func() {
		if _, err := beginLayout(window, request.Ticket); err != nil {
			failure = fmt.Sprintf("begin the layout: %v", err)
			return
		}
		if err := s.joinViewsForPresentRequest(window, request, request.Placements); err != nil {
			failure = fmt.Sprintf("join the presented view: %v", err)
			return
		}
		if err := s.presentation.cancelAll(); err != nil {
			failure = fmt.Sprintf("cancel the open tickets: %v", err)
			return
		}
		_, finished := s.finishLayoutPresentation(window, request)
		if finished == nil || finished.Error() != "surface preparation 9 is no longer current" {
			failure = fmt.Sprintf("the presentation of the cancelled ticket answered %v", finished)
			return
		}
		if len(s.presentation.pending) != 0 {
			failure = fmt.Sprintf("the cancelled ticket left pending state %v", s.presentation.pending)
			return
		}
		// The failed presentation cancelled the native transaction of its ticket, which the abandon of the join left open.
		if system.CommitLayout(window, request.Ticket) {
			failure = "the native layer took the commit of ticket 9 after the failed presentation cancelled it"
		}
	})
	if failure != "" {
		t.Fatal(failure)
	}
}

// contract: view.presentation-wait.joins
// A shown view joins the open transaction once, and its presentation ends the wait without an abandon.
func TestAShownViewJoinsTheOpenTransactionOnce(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	window := platform.Window(1)
	shown := []Placement{{ID: "probe-surface", Visible: true}}
	if err := joins.shown(s, window, 7, shown); err != nil {
		t.Fatalf("join: %v", err)
	}
	if len(joins.requests) != 1 {
		t.Fatalf("the shown view joined %d transactions, want 1", len(joins.requests))
	}
	if joins.requests[0].ticket != 7 || joins.requests[0].window != window {
		t.Fatalf("the join has ticket %d and window %v, want 7 and the window of the layout", joins.requests[0].ticket, joins.requests[0].window)
	}
	if err := joins.shown(s, window, 7, shown); err != nil {
		t.Fatalf("second join: %v", err)
	}
	if len(joins.requests) != 1 {
		t.Fatalf("a view that waits joined again: %d joins", len(joins.requests))
	}
	joins.present(s, 0)
	if s.presentation.waits("probe-surface") {
		t.Fatalf("the presentation did not end the wait")
	}
	if joins.abandons[0] != 0 {
		t.Fatalf("the presentation abandoned the native join")
	}
	if err := joins.shown(s, window, 8, shown); err != nil {
		t.Fatalf("join after presentation: %v", err)
	}
	if len(joins.requests) != 2 {
		t.Fatalf("the view joined %d transactions after its presentation, want 2", len(joins.requests))
	}
}

// contract: view.presentation-wait.joins
// Each end without presentation abandons the native join of the view once: the process end, the hidden view and the unresponsive notice.
func TestEachEndWithoutPresentationAbandonsTheViewJoin(t *testing.T) {
	shown := []Placement{{ID: "probe-surface", Visible: true}}
	window := platform.Window(1)
	for _, reason := range []string{"process-ended", "hidden", "unresponsive"} {
		t.Run(reason, func(t *testing.T) {
			isolateTraceRecords(t)
			s, views, native := newLifecycleSurfaces(t)
			joins := &viewJoins{}
			s.views = map[string]*nativeWebview{"probe-surface": {}}
			events := recordWindowEvents(s)
			if err := joins.shown(s, window, 7, shown); err != nil {
				t.Fatalf("join: %v", err)
			}
			if len(joins.requests) != 1 {
				t.Fatalf("the shown view joined %d transactions, want 1", len(joins.requests))
			}
			switch reason {
			case "process-ended":
				endView(t, s, views, viewTestEpoch)
			case "hidden":
				if step := views.sync(t, s, native, false, nullOriginStart()); step != viewSyncPlace {
					t.Fatalf("hide the view: planned step %d, want the placement of the view", step)
				}
			case "unresponsive":
				s.viewResponsiveness("probe-surface", "probe", 1, false)
			}
			if joins.abandons[0] != 1 {
				t.Fatalf("the %s end abandoned the native join %d times, want 1", reason, joins.abandons[0])
			}
			if s.presentation.waits("probe-surface") {
				t.Fatalf("the %s end left the view waiting", reason)
			}
			var abandoned []map[string]any
			for _, event := range *events {
				if event.name == "view-presentation-abandoned" {
					data, _ := event.data.(map[string]any)
					abandoned = append(abandoned, data)
				}
			}
			if len(abandoned) != 1 {
				t.Fatalf("the %s end sent %d view-presentation-abandoned notices, want 1: %v", reason, len(abandoned), *events)
			}
			if abandoned[0]["surface"] != "probe-surface" || abandoned[0]["reason"] != reason {
				t.Fatalf("the %s notice carries %v, want its surface and reason", reason, abandoned[0])
			}
		})
	}
}

// contract: view.presentation-wait.join-trace
func TestPresentationJoinTraceKeepsExactIdentityAcrossCallbackAndAbandonment(t *testing.T) {
	isolateTraceRecords(t)
	wasOn := performanceOn.Swap(true)
	t.Cleanup(func() { performanceOn.Store(wasOn) })
	s, _, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	window := platform.Window(1)
	placement := Placement{ID: "probe-surface", Visible: true}
	channel, ok := s.documents.view(placement.ID)
	if !ok {
		t.Fatal("the view channel is missing")
	}
	generation := channel.generation

	if err := joins.shown(s, window, 70, []Placement{placement}); err != nil {
		t.Fatalf("join view: %v", err)
	}
	if len(joins.requests) != 1 {
		t.Fatalf("native joins = %d, want 1", len(joins.requests))
	}
	joins.present(s, 0)

	placement.Rect.W = 321
	if err := joins.shown(s, window, 71, []Placement{placement}); err != nil {
		t.Fatalf("join changed view: %v", err)
	}
	if len(joins.requests) != 2 {
		t.Fatalf("native joins after changed placement = %d, want 2", len(joins.requests))
	}
	s.endPresentationWaitFor(placement.ID, 71, generation, "hidden")
	// The platform callback is deliberately delivered after abandonment. It is trace evidence, not a live wait completion.
	joins.present(s, 1)

	got := bufferedTraces(t, presentationJoinTrace)
	wantPhases := []string{"requested", "result", "presented", "requested", "result", "abandoned", "presented"}
	if len(got) != len(wantPhases) {
		t.Fatalf("presentation-join records = %#v, want phases %v for surface %s generation %d", got, wantPhases, placement.ID, generation)
	}
	for index, phase := range wantPhases {
		if got[index]["phase"] != phase || got[index]["surface"] != placement.ID || got[index]["generation"] != float64(generation) {
			t.Fatalf("presentation-join record %d = %#v, want phase %s for surface %s generation %d", index, got[index], phase, placement.ID, generation)
		}
		wantTicket := float64(70)
		if index >= 3 {
			wantTicket = 71
		}
		if got[index]["ticket"] != wantTicket {
			t.Fatalf("presentation-join record %d ticket = %#v, want %v", index, got[index]["ticket"], wantTicket)
		}
	}
	if got[1]["joined"] != true || got[4]["joined"] != true || got[5]["reason"] != "hidden" {
		t.Fatalf("join results or abandonment fields are incorrect: %#v", got)
	}
}

// contract: view.presentation-wait.join-trace
func TestSynchronousPresentationJoinCallbackPrecedesNativeJoinResult(t *testing.T) {
	isolateTraceRecords(t)
	wasOn := performanceOn.Swap(true)
	t.Cleanup(func() { performanceOn.Store(wasOn) })
	s, _, _ := newLifecycleSurfaces(t)
	window := platform.Window(1)
	placement := Placement{ID: "probe-surface", Visible: true}
	channel, ok := s.documents.view(placement.ID)
	if !ok {
		t.Fatal("the view channel is missing")
	}
	request, ok := s.requestViewJoin(window, 72, placement)
	if !ok {
		t.Fatal("the surface has no view to join")
	}
	// The native layer calls the presentation receiver before the join returns, which is the case of a view that already presented.
	s.viewJoinPresented(request)
	if _, joined, err := s.viewJoined(request, viewJoinAnswer{joined: true, abandon: func() error { return nil }}); err != nil || !joined {
		t.Fatalf("join view: joined %v, error %v", joined, err)
	}
	got := bufferedTraces(t, presentationJoinTrace)
	wantPhases := []string{"requested", "presented", "result"}
	if len(got) != len(wantPhases) {
		t.Fatalf("synchronous presentation-join records = %#v, want phases %v", got, wantPhases)
	}
	for index, phase := range wantPhases {
		if got[index]["phase"] != phase || got[index]["surface"] != placement.ID || got[index]["generation"] != float64(channel.generation) || got[index]["ticket"] != float64(72) {
			t.Fatalf("synchronous presentation-join record %d = %#v, want phase %s and exact join identity", index, got[index], phase)
		}
	}
	if got[2]["joined"] != true {
		t.Fatalf("native join result = %#v, want joined true", got[2])
	}
}

// A joined view that has neither presented nor ended when a press or key event ends the hold ends its wait with the reason input:
// the native join ended by itself, so the host abandons no native join; the platform has no delayed step, so no wait ends by time
// (docs/spec/native-surfaces.md#layout-transaction).
// contract: view.presentation-wait.ends-at-input
func TestAJoinedViewThatDoesNotPresentEndsItsWaitAtInput(t *testing.T) {
	isolateTraceRecords(t)
	s, _, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	window := platform.Window(1)
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	request := PresentRequest{Ticket: 41, Placements: []Placement{placement}}
	if err := joins.forRequest(s, window, request, request.Placements); err != nil {
		t.Fatalf("join the view: %v", err)
	}
	if len(joins.requests) != 1 {
		t.Fatalf("the shown view joined %d times, want 1", len(joins.requests))
	}
	joins.end(s, 0, "input")
	if s.presentation.waits(placement.ID) {
		t.Fatal("the wait of a view that did not present still holds after the input ended the hold")
	}
	if joins.abandons[0] != 0 {
		t.Fatalf("the host abandoned the native join %d times after the native join ended by itself, want 0", joins.abandons[0])
	}
	got := bufferedTraces(t, "host.trace.view.presentation-abandoned")
	if len(got) != 1 || got[0]["reason"] != "input" {
		t.Fatalf("abandoned records %v, want one with the reason input", got)
	}
	// The same generation joins the next transaction, because the input ends one hold and not the view.
	moved := placement
	moved.Rect.X = 40
	next := PresentRequest{Ticket: 42, Placements: []Placement{moved}}
	if err := joins.forRequest(s, window, next, next.Placements); err != nil {
		t.Fatalf("join the moved view: %v", err)
	}
	if len(joins.requests) != 2 {
		t.Fatalf("the generation whose wait ended at input joined %d times, want 2", len(joins.requests))
	}
}

// contract: view.presentation-wait.ends-at-input
func TestAnInputEndAfterThePresentationChangesNothing(t *testing.T) {
	isolateTraceRecords(t)
	s, _, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	window := platform.Window(1)
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	request := PresentRequest{Ticket: 41, Placements: []Placement{placement}}
	if err := joins.forRequest(s, window, request, request.Placements); err != nil {
		t.Fatalf("join the view: %v", err)
	}
	joins.present(s, 0)
	joins.end(s, 0, "input")
	if s.presentation.waits(placement.ID) || joins.abandons[0] != 0 {
		t.Fatalf("an input end after the presentation changed the join: waits %v, abandons %d", s.presentation.waits(placement.ID), joins.abandons[0])
	}
	if got := bufferedTraces(t, "host.trace.view.presentation-abandoned"); len(got) != 0 {
		t.Fatalf("an input end after the presentation wrote abandoned records %v", got)
	}
}

// contract: surface-layout.keyboard-follows-the-focus-ring
func TestAnImageRegionDeclarationKeepsTheKeysOfItsSurface(t *testing.T) {
	cases := []struct {
		name        string
		composition SurfaceComposition
		want        bool
	}{
		{"no composition", SurfaceComposition{}, false},
		{"a page alone", SurfaceComposition{Kind: "view", Page: "ui/page.html"}, false},
		{"a document region", SurfaceComposition{Regions: []SurfaceRegion{{Name: "page", Kind: "document", Input: "native"}}}, false},
		{"an image region", SurfaceComposition{Regions: []SurfaceRegion{{Name: "page", Kind: "document", Input: "native"}, {Name: "view", Kind: "image", Input: "dom"}}}, true},
	}
	for _, c := range cases {
		if got := c.composition.declaresImageRegion(); got != c.want {
			t.Errorf("%s: declaresImageRegion = %v, want %v", c.name, got, c.want)
		}
	}
}

// contract: surface-layout.keyboard-follows-the-focus-ring
func TestSurfaceFocusRefusesAWindowlessCallAndAMissingMember(t *testing.T) {
	useCurrentPlatformForViews(t)
	s, _, _ := newLifecycleSurfaces(t)
	s.window = nil
	if err := s.FocusSurface(FocusRequest{}); err != errNoWindow {
		t.Fatalf("FocusSurface without a window = %v, want %v", err, errNoWindow)
	}
	if err := (&Host{}).SurfaceFocus(context.Background(), json.RawMessage(`{"surface":5}`)); err == nil || err.Error() != "argument request.surface must be a string, not a number" {
		t.Fatalf("SurfaceFocus with a number = %v", err)
	}
	s.window = &noticeFrontend{}
	surface := "gone"
	if err := s.FocusSurface(FocusRequest{Surface: &surface}); err == nil || err.Error() != `surface "gone" is not attached` {
		t.Fatalf("FocusSurface of a surface that is not attached = %v", err)
	}
}

// keysWaitPlatform records the keyboard calls of the host in their order and runs the work of the UI thread at once.
type keysWaitPlatform struct {
	platform.Platform
	calls []string
}

func (p *keysWaitPlatform) EnqueueUI(run func()) error {
	run()
	return nil
}
func (p *keysWaitPlatform) FocusWorkbench(platform.Window) {
	p.calls = append(p.calls, "workbench")
}
func (p *keysWaitPlatform) KeysDecided(platform.Window)   { p.calls = append(p.calls, "decided") }
func (p *keysWaitPlatform) KeysPageEnded(platform.Window) { p.calls = append(p.calls, "page ended") }

// CancelLayout answers the cancel of the layouts of the window at the end of its page, which the key checks do not record.
func (p *keysWaitPlatform) CancelLayout(platform.Window) error { return nil }

// contract: surface-layout.keys-wait-for-the-decision
func TestADecidedCallGivesTheKeysAndAPlainCallDoesNot(t *testing.T) {
	decided, err := argument[FocusRequest]("request", json.RawMessage(`{"surface":null,"decided":true}`))
	if err != nil || decided.Surface != nil || !decided.Decided {
		t.Fatalf("a decided call = %+v, %v; want the workbench and decided", decided, err)
	}
	plain, err := argument[FocusRequest]("request", json.RawMessage(`{"surface":"tab-1"}`))
	if err != nil || plain.Surface == nil || *plain.Surface != "tab-1" || plain.Decided {
		t.Fatalf("a call without decided = %+v, %v; want tab-1 and not decided", plain, err)
	}
	if _, err := argument[FocusRequest]("request", json.RawMessage(`{"surface":"tab-1","decided":"yes"}`)); err == nil {
		t.Fatalf("a decided that is not a boolean was accepted")
	}
}

// contract: surface-layout.keys-wait-for-the-decision
func TestTheKeysOfTheWindowWaitForTheDecisionOfTheWorkbench(t *testing.T) {
	fake := &keysWaitPlatform{}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{}
	if err := s.FocusSurface(FocusRequest{Decided: true}); err != errNoWindow {
		t.Fatalf("a decided call without a window = %v, want %v", err, errNoWindow)
	}
	s.window = &noticeFrontend{}
	if err := s.FocusSurface(FocusRequest{}); err != nil {
		t.Fatalf("a call without the decision: %v", err)
	}
	if err := s.FocusSurface(FocusRequest{Decided: true}); err != nil {
		t.Fatalf("a decided call: %v", err)
	}
	gone := "gone"
	if err := s.FocusSurface(FocusRequest{Surface: &gone, Decided: true}); err == nil {
		t.Fatalf("a decided call for a surface that is not attached was not refused")
	}
	want := []string{"workbench", "workbench", "decided", "decided"}
	if !slices.Equal(fake.calls, want) {
		t.Fatalf("the keyboard calls of the host are %v, want %v: a decided call gives the keys after the keyboard moved, also when it is refused", fake.calls, want)
	}
	// No call of the page holds the keys or ends a hold: the keys follow surfaceFocus alone.
	for _, name := range []string{"KeyboardHold", "KeyboardDecided"} {
		if _, ok := reflect.TypeOf(&Host{}).MethodByName(name); ok {
			t.Errorf("the host still binds %s", name)
		}
	}
}

// contract: surface-layout.keys-wait-for-the-decision
func TestTheEndOfTheMainPageGivesTheKeys(t *testing.T) {
	fake := &keysWaitPlatform{}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{window: &noticeFrontend{}}
	s.mainPageEnded()
	if want := []string{"page ended"}; !slices.Equal(fake.calls, want) {
		t.Fatalf("the end of the main page made the calls %v, want %v: the keys that waited go where the keyboard is", fake.calls, want)
	}
}

// contract: surface-layout.page-cancels-preparation
func TestCancelSurfacesWithoutAWindowIsRefused(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t)
	s.window = nil
	if err := s.CancelSurfaces(CancelRequest{Ticket: 42}); err != errNoWindow {
		t.Fatalf("CancelSurfaces without a window = %v, want %v", err, errNoWindow)
	}
}

// contract: view.presentation-wait.surface-close-ends-it
func TestTheCloseOfTheDocumentsOfASurfaceEndsThePresentationWaitOfItsView(t *testing.T) {
	isolateTraceRecords(t)
	s, _, _ := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	if err := joins.shown(s, platform.Window(1), 7, []Placement{{ID: "probe-surface", Visible: true}}); err != nil {
		t.Fatalf("join: %v", err)
	}
	if len(joins.requests) != 1 {
		t.Fatalf("the shown view joined %d transactions, want 1", len(joins.requests))
	}
	s.closeSurfaceDocumentsWith("probe-surface", func(unsafe.Pointer) {})
	if s.presentation.waits("probe-surface") {
		t.Fatal("the close of the documents of the surface left its view waiting for its presentation")
	}
	if joins.abandons[0] != 1 {
		t.Fatalf("the close abandoned the native join %d times, want 1", joins.abandons[0])
	}
	var reasons []any
	for _, event := range *events {
		if event.name == "view-presentation-abandoned" {
			data, _ := event.data.(map[string]any)
			reasons = append(reasons, data["reason"])
		}
	}
	if len(reasons) != 1 || reasons[0] != "closed" {
		t.Fatalf("the close sent the abandon reasons %v, want [closed]", reasons)
	}
}
