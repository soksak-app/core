package host

import (
	"testing"
	"time"
	"unsafe"
)

const presentationJoinTrace = "host.trace.view.presentation-join"

type synchronousPresentationPlatform struct{ *lifecyclePlatform }

func (p synchronousPresentationPlatform) JoinView(window unsafe.Pointer, ticket uint64, view unsafe.Pointer, presented func()) (func() error, bool, error) {
	abandon, joined, err := p.lifecyclePlatform.JoinView(window, ticket, view, presented)
	if err == nil && joined {
		presented()
	}
	return abandon, joined, err
}

// contract: view.presentation-wait.changed-root-joins-each-geometry
func TestUnsettledChangedRootPlacementJoinsItsPresentation(t *testing.T) {
	s, fake, _ := newLifecycleSurfaces(t, &fakeClock{})
	window := unsafe.Pointer(new(int))
	placements := []Placement{{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}}
	request := PresentRequest{Ticket: 23, Placements: placements, Settled: false}
	if err := s.joinViewsForPresentRequest(window, request, placements); err != nil {
		t.Fatalf("join changed placement: %v", err)
	}
	if len(fake.joins) != 1 {
		t.Fatalf("unsettled changed root placement joined %d views, want 1", len(fake.joins))
	}
	if fake.joins[0].ticket != request.Ticket || fake.joins[0].view != fake.created[0] {
		t.Fatalf("join ticket/view are %d/%p, want %d/%p", fake.joins[0].ticket, fake.joins[0].view, request.Ticket, fake.created[0])
	}
}

// contract: view.presentation-wait.rejoins-current-generation-before-commit
func TestProcessEndedRootIsRejoinedOnItsOpenTicketBeforeCommit(t *testing.T) {
	s, fake, _ := newLifecycleSurfaces(t, &fakeClock{})
	window := unsafe.Pointer(new(int))
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	request := PresentRequest{Ticket: 36, Placements: []Placement{placement}, Settled: false}
	if err := s.joinViewsForPresentRequest(window, request, request.Placements); err != nil {
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
	if err := s.ensureCurrentPresentationJoins(window, request); err != nil {
		t.Fatalf("recheck presentation generation: %v", err)
	}
	if len(fake.joins) != 2 || fake.joins[1].ticket != request.Ticket || fake.joins[1].view != replacementRoot {
		t.Fatalf("same-ticket joins are %+v; want generation %d joined to ticket %d before commit", fake.joins, replacementGeneration, request.Ticket)
	}
}

// contract: view.presentation-wait.rejoins-current-generation-before-commit
func TestRestartLimitLeavesNoReplacementGenerationToJoin(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	window := unsafe.Pointer(new(int))
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	request := PresentRequest{Ticket: 37, Placements: []Placement{placement}, Settled: false}
	if err := s.joinViewsForPresentRequest(window, request, request.Placements); err != nil {
		t.Fatalf("join initial generation: %v", err)
	}
	initial, ok := s.documents.view(placement.ID)
	if !ok {
		t.Fatal("initial root view channel is missing")
	}
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second, 30 * time.Second} {
		clock.set(offset)
		endView(t, s, fake)
	}
	if !s.viewRecords().isStopped(placement.ID) {
		t.Fatal("the fourth process end did not stop the view restart")
	}
	if _, ok := s.documents.view(placement.ID); ok {
		t.Fatal("a replacement view exists after the restart limit")
	}
	if err := s.ensureCurrentPresentationJoins(window, request); err != nil {
		t.Fatalf("the stopped view blocked its open layout: %v", err)
	}
	state := s.presentation.pending[request.Ticket]
	if !state.invalid[placement.ID] || state.placements[placement.ID].generation != initial.generation {
		t.Fatalf("stopped view pending state = %+v; want invalid old generation and no replacement", state)
	}
}

// contract: view.presentation-wait.rejoins-current-generation-before-commit
func TestRestartLimitInvalidatesPlacementAfterItsJoinPresented(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	events := recordWindowEvents(s)
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second} {
		clock.set(offset)
		endView(t, s, fake)
	}
	window := unsafe.Pointer(new(int))
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	request := PresentRequest{Ticket: 39, Placements: []Placement{placement}, Settled: false}
	if err := s.joinViewsForPresentRequest(window, request, request.Placements); err != nil {
		t.Fatalf("join current generation: %v", err)
	}
	current, ok := s.documents.view(placement.ID)
	if !ok {
		t.Fatal("current root generation is missing before its presentation")
	}
	fake.joins[len(fake.joins)-1].presented()
	if fake.joins[len(fake.joins)-1].abandons != 0 {
		t.Fatal("a presented join was abandoned")
	}
	clock.set(30 * time.Second)
	endView(t, s, fake)
	if !s.viewRecords().isStopped(placement.ID) {
		t.Fatal("the fourth process end did not stop the view restart")
	}
	if _, ok := s.documents.view(placement.ID); ok {
		t.Fatal("a replacement root exists after the restart limit")
	}
	if err := s.ensureCurrentPresentationJoins(window, request); err != nil {
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

// contract: view.presentation-wait.rejoins-current-generation-before-commit
func TestInitiallyAbsentRootGenerationIsNotPromoted(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t, &fakeClock{})
	window := unsafe.Pointer(new(int))
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	if _, err := s.documents.Remove(DocumentKey{Surface: placement.ID, Name: viewRegionName}); err != nil {
		t.Fatalf("remove initial root document: %v", err)
	}
	request := PresentRequest{Ticket: 38, Placements: []Placement{placement}, Settled: false}
	if err := s.joinViewsForPresentRequest(window, request, request.Placements); err != nil {
		t.Fatalf("prepare placement without an initial root generation: %v", err)
	}
	if err := s.ensureCurrentPresentationJoins(window, request); err != nil {
		t.Fatalf("an absent initial root generation blocked its open layout: %v", err)
	}
	state := s.presentation.pending[request.Ticket]
	if !state.invalid[placement.ID] || state.placements[placement.ID].generation != 0 || state.joined[placement.ID] != 0 {
		t.Fatalf("absent initial generation was promoted: %+v", state)
	}
}

// contract: view.presentation-wait.changed-root-joins-each-geometry
func TestChangedPlacementJoinTracksCommittedGeometryVisibilityAndGeneration(t *testing.T) {
	s, fake, _ := newLifecycleSurfaces(t, &fakeClock{})
	root := fake.created[0]
	child := unsafe.Pointer(new(int))
	childKey := DocumentKey{Surface: "probe-surface", Name: "studio"}
	if err := s.documents.Reserve(childKey); err != nil || !s.documents.Set(childKey, child) {
		t.Fatalf("register nested document: reserve error %v", err)
	}
	window := unsafe.Pointer(new(int))
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 14, Y: 28, W: 320, H: 180}, Visible: true}
	request := func(ticket uint64, p Placement) PresentRequest {
		return PresentRequest{Ticket: ticket, Placements: []Placement{p}, Settled: false}
	}
	join := func(req PresentRequest, p Placement) {
		t.Helper()
		if err := s.joinViewsForPresentRequest(window, req, []Placement{p}); err != nil {
			t.Fatalf("join ticket %d: %v", req.Ticket, err)
		}
	}
	complete := func(ticket uint64) {
		t.Helper()
		s.presentation.accept(ticket)
		fake.joins[len(fake.joins)-1].presented()
	}

	first := request(30, placement)
	join(first, placement)
	if len(fake.joins) != 1 || fake.joins[0].view != root || fake.joins[0].view == child {
		t.Fatalf("first join targets %v; want only root view %p, not nested document %p", fake.joins, root, child)
	}
	complete(first.Ticket)

	unchanged := request(31, placement)
	join(unchanged, placement)
	if len(fake.joins) != 1 {
		t.Fatalf("unchanged placement added a join; total joins %d, want 1", len(fake.joins))
	}
	s.presentation.accept(unchanged.Ticket)

	placement.Rect.W = 321
	changed := request(32, placement)
	join(changed, placement)
	if len(fake.joins) != 2 || fake.joins[1].ticket != changed.Ticket {
		t.Fatalf("changed placement joins %v; want one join for ticket %d", fake.joins, changed.Ticket)
	}
	complete(changed.Ticket)

	placement.Visible = false
	hidden := request(33, placement)
	join(hidden, placement)
	if len(fake.joins) != 2 {
		t.Fatalf("hidden placement added a join; total joins %d, want 2", len(fake.joins))
	}
	s.presentation.accept(hidden.Ticket)

	placement.Visible = true
	shown := request(34, placement)
	join(shown, placement)
	if len(fake.joins) != 3 || fake.joins[2].ticket != shown.Ticket {
		t.Fatalf("newly shown placement joins %v; want one join for ticket %d", fake.joins, shown.Ticket)
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
	if len(fake.joins) != 4 || fake.joins[3].ticket != recreated.Ticket || fake.joins[3].view != recreatedRoot {
		t.Fatalf("recreated generation joins %v; want root view %p for ticket %d", fake.joins, recreatedRoot, recreated.Ticket)
	}
}

// contract: view.presentation-wait.completion-is-ticket-and-generation-specific
func TestOlderViewPresentationCannotEndANewerJoin(t *testing.T) {
	s, fake, _ := newLifecycleSurfaces(t, &fakeClock{})
	window := unsafe.Pointer(new(int))
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 1, Y: 2, W: 300, H: 160}, Visible: true}
	first := PresentRequest{Ticket: 40, Placements: []Placement{placement}}
	if err := s.joinViewsForPresentRequest(window, first, []Placement{placement}); err != nil {
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
	if err := s.joinViewsForPresentRequest(window, second, []Placement{placement}); err != nil {
		t.Fatalf("join second ticket: %v", err)
	}
	s.presentation.accept(second.Ticket)
	fake.joins[0].presented()
	if !s.presentation.waits(placement.ID) {
		t.Fatal("the first ticket's late callback ended the newer presentation wait")
	}
	fake.joins[1].presented()
	if s.presentation.waits(placement.ID) {
		t.Fatal("the current ticket's callback did not end its presentation wait")
	}
}

// contract: view.presentation-wait.cancel-clears-ticket
func TestLayoutCancellationClearsItsJoinWithoutPresentationAbandonment(t *testing.T) {
	s, fake, _ := newLifecycleSurfaces(t, &fakeClock{})
	var events []string
	s.events = func(name string, data any) { events = append(events, name) }
	window := unsafe.Pointer(new(int))
	placement := Placement{ID: "probe-surface", Rect: Rect{X: 1, Y: 2, W: 300, H: 160}, Visible: true}
	request := PresentRequest{Ticket: 42, Placements: []Placement{placement}}
	if err := s.joinViewsForPresentRequest(window, request, []Placement{placement}); err != nil {
		t.Fatalf("join canceled ticket: %v", err)
	}
	s.presentation.accept(request.Ticket)
	if err := s.cancelLayoutPresentation(window, request.Ticket); err != nil {
		t.Fatalf("cancel layout: %v", err)
	}
	if s.presentation.waits(placement.ID) || len(s.presentation.pending) != 0 {
		t.Fatalf("canceled ticket left wait or pending state: waits=%v pending=%v", s.presentation.waiting, s.presentation.pending)
	}
	if len(fake.joins) != 1 {
		t.Fatalf("canceled ticket has %d native joins, want 1", len(fake.joins))
	}
	if fake.joins[0].abandons != 1 {
		t.Fatalf("canceled join abandonment count is %d; want 1", fake.joins[0].abandons)
	}
	if len(fake.cancelledLayouts) != 1 || fake.cancelledLayouts[0] != window {
		t.Fatalf("native layout cancellations are %v; want exactly window %p", fake.cancelledLayouts, window)
	}
	if len(fake.cancelledTickets) != 1 || fake.cancelledTickets[0] != request.Ticket {
		t.Fatalf("native layout cancellation tickets are %v; want only %d", fake.cancelledTickets, request.Ticket)
	}
	if len(fake.layoutOperations) != 2 || fake.layoutOperations[0] != "abandon" || fake.layoutOperations[1] != "cancel-ticket" {
		t.Fatalf("layout cancellation operations are %v; want join abandonment before exact-ticket cancellation", fake.layoutOperations)
	}
	for _, event := range events {
		if event == "view-presentation-abandoned" {
			t.Fatal("layout cancellation reported presentation abandonment")
		}
	}
	fake.joins[0].presented()
	if s.presentation.waits(placement.ID) {
		t.Fatal("late callback from a canceled ticket restored or ended a wait")
	}
}

// contract: view.presentation-wait.joins
// A shown view joins the open transaction once, and its presentation ends the wait without an abandon.
func TestAShownViewJoinsTheOpenTransactionOnce(t *testing.T) {
	s, fake, _ := newLifecycleSurfaces(t, &fakeClock{})
	window := unsafe.Pointer(new(int))
	shown := []Placement{{ID: "probe-surface", Visible: true}}
	if err := s.joinShownViews(window, 7, shown); err != nil {
		t.Fatalf("join: %v", err)
	}
	if len(fake.joins) != 1 {
		t.Fatalf("the shown view joined %d transactions, want 1", len(fake.joins))
	}
	if fake.joins[0].ticket != 7 || fake.joins[0].window != window {
		t.Fatalf("the join has ticket %d and window %p, want 7 and the window of the layout", fake.joins[0].ticket, fake.joins[0].window)
	}
	if err := s.joinShownViews(window, 7, shown); err != nil {
		t.Fatalf("second join: %v", err)
	}
	if len(fake.joins) != 1 {
		t.Fatalf("a view that waits joined again: %d joins", len(fake.joins))
	}
	fake.joins[0].presented()
	if s.presentation.waits("probe-surface") {
		t.Fatalf("the presentation did not end the wait")
	}
	if fake.joins[0].abandons != 0 {
		t.Fatalf("the presentation abandoned the native join")
	}
	if err := s.joinShownViews(window, 8, shown); err != nil {
		t.Fatalf("join after presentation: %v", err)
	}
	if len(fake.joins) != 2 {
		t.Fatalf("the view joined %d transactions after its presentation, want 2", len(fake.joins))
	}
}

// contract: view.presentation-wait.joins
// Each end without presentation abandons the native join of the view once: the process end, the hidden view and the unresponsive notice.
func TestEachEndWithoutPresentationAbandonsTheViewJoin(t *testing.T) {
	shown := []Placement{{ID: "probe-surface", Visible: true}}
	window := unsafe.Pointer(new(int))
	for _, reason := range []string{"process-ended", "hidden", "unresponsive"} {
		t.Run(reason, func(t *testing.T) {
			isolateTraceRecords(t)
			s, fake, native := newLifecycleSurfaces(t, &fakeClock{})
			s.views = map[string]*nativeWebview{"probe-surface": {}}
			events := recordWindowEvents(s)
			if err := s.joinShownViews(window, 7, shown); err != nil {
				t.Fatalf("join: %v", err)
			}
			if len(fake.joins) != 1 {
				t.Fatalf("the shown view joined %d transactions, want 1", len(fake.joins))
			}
			switch reason {
			case "process-ended":
				endView(t, s, fake)
			case "hidden":
				if err := s.syncView("probe-surface", native, "probe", "ui/page.html", false, nullOriginStart()); err != nil {
					t.Fatalf("hide the view: %v", err)
				}
			case "unresponsive":
				s.viewResponsiveness("probe-surface", "probe", 1, false)
			}
			if fake.joins[0].abandons != 1 {
				t.Fatalf("the %s end abandoned the native join %d times, want 1", reason, fake.joins[0].abandons)
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
	s, fake, _ := newLifecycleSurfaces(t, &fakeClock{})
	window := unsafe.Pointer(new(int))
	placement := Placement{ID: "probe-surface", Visible: true}
	channel, ok := s.documents.view(placement.ID)
	if !ok {
		t.Fatal("the view channel is missing")
	}
	generation := channel.generation

	if err := s.joinShownViews(window, 70, []Placement{placement}); err != nil {
		t.Fatalf("join view: %v", err)
	}
	if len(fake.joins) != 1 {
		t.Fatalf("native joins = %d, want 1", len(fake.joins))
	}
	fake.joins[0].presented()

	placement.Rect.W = 321
	if err := s.joinShownViews(window, 71, []Placement{placement}); err != nil {
		t.Fatalf("join changed view: %v", err)
	}
	if len(fake.joins) != 2 {
		t.Fatalf("native joins after changed placement = %d, want 2", len(fake.joins))
	}
	s.endPresentationWaitFor(placement.ID, 71, generation, "hidden")
	// The platform callback is deliberately delivered after abandonment. It is trace evidence, not a live wait completion.
	fake.joins[1].presented()

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
	s, fake, _ := newLifecycleSurfaces(t, &fakeClock{})
	system = synchronousPresentationPlatform{fake}
	window := unsafe.Pointer(new(int))
	placement := Placement{ID: "probe-surface", Visible: true}
	channel, ok := s.documents.view(placement.ID)
	if !ok {
		t.Fatal("the view channel is missing")
	}
	if err := s.joinShownViews(window, 72, []Placement{placement}); err != nil {
		t.Fatalf("join view: %v", err)
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
