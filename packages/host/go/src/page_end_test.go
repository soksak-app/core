package host

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// pageEndWindow is a window whose page a test ends: it holds the listeners of its window events and the hook of its close, and
// sends each event that the host sends to its page, each close and each start of its workbench to sent.
type pageEndWindow struct {
	settlingWindow
	listeners map[WindowEvent][]func()
	sent      chan string
	mu        sync.Mutex
	closes    int
	// settled is nil for a window whose screen presents through the main web view of the platform. Otherwise the screen never presents:
	// its presentation is a function of the window, as the presentation of a framework that draws its workbench itself is, and settled
	// receives one signal each time a settled wait asks it to present.
	settled chan struct{}
}

func (w *pageEndWindow) SettledPresentation() (unsafe.Pointer, error) {
	if w.settled == nil {
		return w.settlingWindow.SettledPresentation()
	}
	return system.FunctionPresentation(func(func(error)) error {
		w.settled <- struct{}{}
		return nil
	})
}

func (w *pageEndWindow) OnWindowEvent(event WindowEvent, listener func()) {
	w.listeners[event] = append(w.listeners[event], listener)
}
func (w *pageEndWindow) Emit(name string, _ ...any) { w.sent <- name }
func (w *pageEndWindow) StartWorkbench()            { w.sent <- "start" }
func (w *pageEndWindow) CallWorkbench(string)       {}
func (w *pageEndWindow) Name() string               { return "main" }
func (w *pageEndWindow) Close() {
	w.mu.Lock()
	w.closes++
	w.mu.Unlock()
	w.sent <- "close"
}

// closeCount is the number of closes that the host asked of the window.
func (w *pageEndWindow) closeCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.closes
}

// end runs the listeners of the end of the WebContent process of the main page.
func (w *pageEndWindow) end() {
	for _, listener := range w.listeners[WindowWorkbenchEnded] {
		listener()
	}
}

// waitSent waits until the window received name and drops what it received before. The receipt ends the wait; the limit of the
// test runner reports a window that never receives name.
func (w *pageEndWindow) waitSent(name string) {
	for got := range w.sent {
		if got == name {
			return
		}
	}
}

// newPageEndWindow creates the host of one window of the platform of the operating system whose page is ready. The window has the title
// bar of a framework window and no main web view, and its framework runs its steps on the main thread of the native library. The
// observations of the window end with the test.
func newPageEndWindow(t *testing.T, screen bool) (*Host, *Surfaces, *pageEndWindow) {
	t.Helper()
	useCurrentPlatformForViews(t)
	native := support.TitledWindow(t, runOnMainThread, 400, 300)
	// A work that the end of the page queues for the UI thread (mainPageEnded) calls the platform with the window, so the window closes
	// and the platform of the test ends only after it ran. The main queue serves its works in order, so a work queued at the teardown
	// runs after each work of the test.
	t.Cleanup(func() {
		served := make(chan struct{})
		if err := system.EnqueueUI(func() { close(served) }); err != nil {
			t.Errorf("queue the end of the UI works of the test: %v", err)
			return
		}
		<-served
	})
	window := &pageEndWindow{settlingWindow: settlingWindow{pagelessWindow: pagelessWindow{native: native}},
		listeners: map[WindowEvent][]func(){}, sent: make(chan string, 64)}
	if screen {
		window.settled = make(chan struct{}, 4)
	}
	previousFramework := framework
	framework = nativePagelessFramework{pagelessFramework{window: window}}
	t.Cleanup(func() { framework = previousFramework })
	h := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, sidecars: &Sidecars{}, quit: &Quit{}, relay: NewRelay[relayTarget]()}
	s := h.newWindow("main", "")
	t.Cleanup(func() { endObservations(s) })
	h.mu.Lock()
	s.ready = true
	h.mu.Unlock()
	return h, s, window
}

// pageEndFixture is a host with one window whose page is ready.
func pageEndFixture(t *testing.T) (*Host, *Surfaces, *pageEndWindow) {
	t.Helper()
	return newPageEndWindow(t, false)
}

// askPage sends a command request to the page of s without a limit and returns the channel of its error.
func askPage(t *testing.T, h *Host, s *Surfaces, window *pageEndWindow) <-chan error {
	t.Helper()
	reply := make(chan error, 1)
	go func() {
		_, err := h.ask(context.Background(), s, "command.run", map[string]any{"name": "core.probe", "params": map[string]any{}})
		reply <- err
	}()
	window.waitSent("exposure-request")
	return reply
}

// wantClosedDocument checks that reply ended with the code of a closed document. The reply ends the wait; the limit of the test
// runner reports a request that still waits for a page that ended.
func wantClosedDocument(t *testing.T, reply <-chan error, what string) {
	t.Helper()
	err := <-reply
	var failure *RPCError
	if !errors.As(err, &failure) || failure.Code != codeNoWindow {
		t.Fatalf("%s ended with %v, want %d", what, err, codeNoWindow)
	}
}

// The end of the WebContent process of the page ends the page: a command that the page never answers ends with it, and the window
// is no longer ready, so no later request waits for the page (docs/spec/hosts.md#process-lifecycle).
// contract: application.page-end.answers-the-requests-of-the-page
func TestTheEndOfThePageProcessEndsTheRequestsToThePage(t *testing.T) {
	h, s, window := pageEndFixture(t)
	reply := askPage(t, h, s, window)
	window.end()
	wantClosedDocument(t, reply, "the command request to the page")
	h.mu.Lock()
	ready := s.ready
	h.mu.Unlock()
	if ready {
		t.Fatal("the window of a page that ended is still ready")
	}
}

// A close question that the page did not answer is answered by the end of the page: the window closes, because a page that ended
// keeps no tab (docs/spec/hosts.md#process-lifecycle).
// contract: application.page-end.answers-the-close-question
func TestTheEndOfThePageAnswersTheCloseQuestionThatItLeft(t *testing.T) {
	_, _, window := pageEndFixture(t)
	if !window.closing() {
		t.Fatal("the close of a window whose page is ready did not ask the page")
	}
	window.waitSent("project-close-request")
	window.end()
	if window.closeCount() != 1 {
		t.Fatalf("the end of the page closed the window %d times, want once", window.closeCount())
	}
	window.end()
	if window.closeCount() != 1 {
		t.Fatalf("a second end closed the window again: %d closes", window.closeCount())
	}
}

// heldUI is the platform of the operating system whose UI queue serves the works that the host queues while holding is set only when a
// later work is queued, which is the latest turn in which a queue that serves its works in order can serve them. It counts the works
// that were queued and the works that ran.
type heldUI struct {
	platform.Platform
	mu      sync.Mutex
	holding bool
	held    []func()
	queued  int
	ran     int
}

func (p *heldUI) EnqueueUI(work func()) error {
	counted := func() {
		work()
		p.mu.Lock()
		p.ran++
		p.mu.Unlock()
	}
	p.mu.Lock()
	p.queued++
	if p.holding {
		p.held = append(p.held, counted)
		p.mu.Unlock()
		return nil
	}
	works := append(p.held, counted)
	p.held = nil
	p.mu.Unlock()
	for _, work := range works {
		if err := p.Platform.EnqueueUI(work); err != nil {
			return err
		}
	}
	return nil
}

// release ends the hold, so the next queued work brings the held works to the UI queue before it.
func (p *heldUI) release() {
	p.mu.Lock()
	p.holding = false
	p.mu.Unlock()
}

// end returns the number of the queued works, of the works that ran and of the works that the queue still holds, and drops the held
// works, which name a window and a platform that the test ended.
func (p *heldUI) end() (queued, ran, held int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	queued, ran, held = p.queued, p.ran, len(p.held)
	p.held = nil
	return queued, ran, held
}

// The fixture of a page end closes its window and gives back the platform only after the UI works that the host queued ran, because a
// work of the end of the page (mainPageEnded) calls the platform with the window. The UI queue of the test serves the works of the test
// body no earlier than the teardown of the fixture.
func TestThePageEndFixtureRunsTheUIWorksOfTheHostBeforeItEnds(t *testing.T) {
	queue := &heldUI{holding: true}
	t.Run("page end", func(t *testing.T) {
		_, _, window := pageEndFixture(t)
		queue.Platform = system
		system = queue
		window.end()
		queue.release()
	})
	if queued, ran, held := queue.end(); held != 0 || ran != queued {
		t.Fatalf("the fixture ended with %d of %d UI works of the host not run, %d of them held by the queue", queued-ran, queued, held)
	}
}

// The close of a window cancels every layout transaction of the window in the step of the close, while the framework still holds the
// native window, and queues no work that names the window: the framework releases a closed window, and a work that runs after that
// release would cancel the transaction of a later window that the operating system placed at the same address
// (docs/spec/native-surfaces.md#layout-transaction). The native window of the fixture stays open after the close, so its address stands
// for that later window, and the UI queue of the test holds the works that the close queued until that window began its layout.
// contract: window-close.layout.cancelled-in-close-step
func TestTheCloseOfAWindowCancelsItsLayoutInTheStepOfTheClose(t *testing.T) {
	h, s, window := pageEndFixture(t)
	native := window.native
	t.Cleanup(func() { runOnMainThread(func() { system.CancelLayout(native) }) })
	h.mu.Lock()
	s.ready = false
	h.mu.Unlock()
	calls := &layoutEndCalls{Platform: system, cancelled: make(chan platform.Window, 8)}
	queue := &heldUI{Platform: calls, holding: true}
	previous := system
	system = queue
	t.Cleanup(func() { system = previous })
	begin := func(ticket uint64) {
		began := make(chan bool, 1)
		runOnMainThread(func() {
			if err := system.BeginLayout(native, ticket, func(allowed bool) { began <- allowed }); err != nil {
				t.Errorf("begin the layout %d: %v", ticket, err)
				began <- false
			}
		})
		if !<-began {
			t.Fatalf("the layout %d of the window did not begin", ticket)
		}
	}
	begin(1)
	if window.closing() {
		t.Fatal("a window whose page is not ready kept its close")
	}
	if commitLayout(native, 1) {
		t.Error("the close of the window left its layout 1 open after the step of the close")
	}
	begin(2)
	queue.release()
	served := make(chan struct{})
	if err := system.EnqueueUI(func() { close(served) }); err != nil {
		t.Fatalf("queue the end of the UI works of the test: %v", err)
	}
	<-served
	if !commitLayout(native, 2) {
		t.Error("a work that the close of the window queued cancelled the layout 2 that a later window began at the address of the closed window")
	}
	if queued, ran, held := queue.end(); held != 0 || ran != queued {
		t.Fatalf("the test ended with %d of %d UI works not run, %d of them held by the queue", queued-ran, queued, held)
	}
}

// The reload request ends the page: a request to the page ends in the turn of the request, so the calls of the page that wait for
// it answer and the page can reload (docs/spec/native-host.md#page-reload).
// contract: application.page-end.answers-the-requests-of-the-page
func TestTheReloadRequestEndsTheRequestsToThePage(t *testing.T) {
	h, s, window := pageEndFixture(t)
	reply := askPage(t, h, s, window)
	s.askPageToReload(func() {})
	wantClosedDocument(t, reply, "the command request to the reloading page")
}

// The close of the window ends the reload of its page: the window can no longer report ready (docs/spec/native-host.md#page-reload).
// contract: application.page-reload.ends-with-close-or-failed-start
func TestAReloadEndsWithTheCloseOfItsWindow(t *testing.T) {
	h, s, window := pageEndFixture(t)
	h.mu.Lock()
	s.ready = false
	h.mu.Unlock()
	reloaded := make(chan error, 1)
	go func() { reloaded <- s.reloadPage() }()
	window.waitSent("start")
	if window.closing() {
		t.Fatal("a window whose page is not ready kept its close")
	}
	err := <-reloaded
	var failure *RPCError
	if !errors.As(err, &failure) || failure.Code != codeNoWindow || !strings.Contains(failure.Message, "the window closed before the reloaded page reported ready") {
		t.Fatalf("the reload of a closed window ended with %v", err)
	}
}

// A start of the new page that fails ends the reload with its reason (docs/spec/native-host.md#page-reload).
// contract: application.page-reload.ends-with-close-or-failed-start
func TestAReloadEndsWithAFailedStart(t *testing.T) {
	h, s, window := pageEndFixture(t)
	h.mu.Lock()
	s.ready = false
	h.mu.Unlock()
	s.invoke = stepOnMainThread
	s.reloadCancelLayout = func() error { return errors.New("the layout cannot be cancelled") }
	s.reloadKeysPageEnded = func() {}
	s.reloadHideSurface = func(unsafe.Pointer, bool) {}
	s.reloadCloseImage = func(unsafe.Pointer) {}
	reloaded := make(chan error, 1)
	go func() { reloaded <- s.reloadPage() }()
	window.waitSent("start")
	if _, err := h.startPage(window.ID()); err == nil {
		t.Fatal("the start of the page did not fail")
	}
	err := <-reloaded
	var failure *RPCError
	if !errors.As(err, &failure) || failure.Code != codeNoWindow || !strings.Contains(failure.Message, "the reloaded page did not start: ") ||
		!strings.Contains(failure.Message, "the layout cannot be cancelled") {
		t.Fatalf("the reload whose page failed to start ended with %v", err)
	}
}

// pageCallFixture is a host with one window whose page is ready and whose screen never presents.
func pageCallFixture(t *testing.T) (*Surfaces, *pageEndWindow) {
	t.Helper()
	_, s, window := newPageEndWindow(t, true)
	return s, window
}

// waitResult runs wait and returns the channel of its error.
func waitResult(wait func(context.Context) (float64, error)) <-chan error {
	result := make(chan error, 1)
	go func() {
		_, err := wait(context.Background())
		result <- err
	}()
	return result
}

// wantEnd checks that result ended with 1003 and the text end. The end ends the wait; the limit of the test runner reports a
// wait that does not end.
func wantEnd(t *testing.T, result <-chan error, end, what string) {
	t.Helper()
	if rpc := expectRPCCode(t, result, codeNoWindow, what); rpc.Message != end {
		t.Fatalf("%s ended with %q, want %q", what, rpc.Message, end)
	}
}

// The reload request ends the page, and with it the presented wait of a host call of that page: the page reloads only after
// every call that it sent has its reply, and the screen of the page that ended never presents for it
// (docs/spec/native-host.md#page-reload).
// contract: reload.page-end-ends-the-presented-waits-of-its-calls
func TestTheReloadRequestEndsThePresentedWaitOfACallOfThePage(t *testing.T) {
	s, window := pageCallFixture(t)
	result := waitResult(s.pagePresented)
	<-window.settled
	select {
	case err := <-result:
		t.Fatalf("the presented wait of the page ended at its settled step before the reload request: %v", err)
	default:
	}
	s.askPageToReload(func() {})
	wantEnd(t, result, "the page is reloading", "the presented wait of a call of the reloading page")
}

// A presented call that reaches the host after the reload request ends at once, and a call of the new page waits again.
// contract: reload.page-end-ends-the-presented-waits-of-its-calls
func TestAPresentedCallAfterThePageEndedEndsUntilTheNewPageStarts(t *testing.T) {
	s, window := pageCallFixture(t)
	s.askPageToReload(func() {})
	wantEnd(t, waitResult(s.pagePresented), "the page is reloading", "the presented call after the reload request")
	select {
	case <-window.settled:
		t.Fatal("the presented call after the reload request waited for the screen")
	default:
	}
	s.pageStarted()
	result := waitResult(s.pagePresented)
	<-window.settled
	s.endWindow()
	wantEnd(t, result, windowClosedEnd, "the presented call of the new page")
}

// The end of the page process ends the presented wait of a call of the page with that end.
// contract: reload.page-end-ends-the-presented-waits-of-its-calls
func TestTheEndOfThePageProcessEndsThePresentedWaitOfACallOfThePage(t *testing.T) {
	s, window := pageCallFixture(t)
	result := waitResult(s.pagePresented)
	<-window.settled
	window.end()
	wantEnd(t, result, pageEndedEnd, "the presented wait of a call of the ended page process")
}

// A new page that starts without a reload request ends the presented waits of the calls of the page before it.
// contract: reload.page-end-ends-the-presented-waits-of-its-calls
func TestTheStartOfANewPageEndsThePresentedWaitOfACallOfThePageBeforeIt(t *testing.T) {
	s, window := pageCallFixture(t)
	result := waitResult(s.pagePresented)
	<-window.settled
	s.host.answerPage(s, pageReplacedEnd)
	wantEnd(t, result, pageReplacedEnd, "the presented wait of a call of the replaced page")
}

// The presented wait of an endpoint request, host.window.presented, is no call of the page: the end of the page does not end it,
// and the close of the window does.
// contract: reload.page-end-ends-the-presented-waits-of-its-calls
func TestTheEndOfThePageLeavesThePresentedWaitOfAnEndpointRequest(t *testing.T) {
	s, window := pageCallFixture(t)
	result := waitResult(s.presented)
	<-window.settled
	s.askPageToReload(func() {})
	select {
	case err := <-result:
		t.Fatalf("the reload request ended the presented wait of an endpoint request: %v", err)
	default:
	}
	s.endWindow()
	wantEnd(t, result, windowClosedEnd, "the presented wait of an endpoint request")
}
