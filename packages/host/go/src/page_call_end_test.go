package host

import (
	"context"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// pageCallWindow is a window whose page a test ends and whose settled presentation is a block of its own.
type pageCallWindow struct{ *pageEndWindow }

func (w pageCallWindow) SettledPresentation() (unsafe.Pointer, error) {
	return unsafe.Pointer(w.pageEndWindow), nil
}

// pageCallPlatform answers the native calls of a window whose page ends, and its settled wait answers nothing: settled receives
// one signal each time a wait reaches the settled step.
type pageCallPlatform struct {
	pageEndPlatform
	settled chan struct{}
}

func (p *pageCallPlatform) AfterSettled(platform.Window, unsafe.Pointer, func(float64, error)) error {
	p.settled <- struct{}{}
	return nil
}

// pageCallFixture is a host with one window whose page is ready and whose screen never presents.
func pageCallFixture(t *testing.T) (*Surfaces, *pageEndWindow, *pageCallPlatform) {
	t.Helper()
	window := &pageEndWindow{closingWindow: closingWindow{elementWindow: elementWindow{pagelessWindow: pagelessWindow{native: platform.Window(1)}}},
		listeners: map[WindowEvent][]func(){}, sent: make(chan string, 64)}
	fake := &pageCallPlatform{settled: make(chan struct{}, 4)}
	previousFramework, previousSystem := framework, system
	framework, system = pagelessFramework{window: pageCallWindow{window}}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	h := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, sidecars: &Sidecars{}, quit: &Quit{}, relay: NewRelay[relayTarget]()}
	s := h.newWindow("main", "")
	h.mu.Lock()
	s.ready = true
	h.mu.Unlock()
	return s, window, fake
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
	s, _, fake := pageCallFixture(t)
	result := waitResult(s.pagePresented)
	<-fake.settled
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
	s, _, fake := pageCallFixture(t)
	s.askPageToReload(func() {})
	wantEnd(t, waitResult(s.pagePresented), "the page is reloading", "the presented call after the reload request")
	select {
	case <-fake.settled:
		t.Fatal("the presented call after the reload request waited for the screen")
	default:
	}
	s.pageStarted()
	result := waitResult(s.pagePresented)
	<-fake.settled
	s.endWindow()
	wantEnd(t, result, windowClosedEnd, "the presented call of the new page")
}

// The end of the page process ends the presented wait of a call of the page with that end.
// contract: reload.page-end-ends-the-presented-waits-of-its-calls
func TestTheEndOfThePageProcessEndsThePresentedWaitOfACallOfThePage(t *testing.T) {
	s, window, fake := pageCallFixture(t)
	result := waitResult(s.pagePresented)
	<-fake.settled
	window.end()
	wantEnd(t, result, pageEndedEnd, "the presented wait of a call of the ended page process")
}

// A new page that starts without a reload request ends the presented waits of the calls of the page before it.
// contract: reload.page-end-ends-the-presented-waits-of-its-calls
func TestTheStartOfANewPageEndsThePresentedWaitOfACallOfThePageBeforeIt(t *testing.T) {
	s, _, fake := pageCallFixture(t)
	result := waitResult(s.pagePresented)
	<-fake.settled
	s.host.answerPage(s, pageReplacedEnd)
	wantEnd(t, result, pageReplacedEnd, "the presented wait of a call of the replaced page")
}

// The presented wait of an endpoint request, host.window.presented, is no call of the page: the end of the page does not end it,
// and the close of the window does.
// contract: reload.page-end-ends-the-presented-waits-of-its-calls
func TestTheEndOfThePageLeavesThePresentedWaitOfAnEndpointRequest(t *testing.T) {
	s, _, fake := pageCallFixture(t)
	result := waitResult(s.presented)
	<-fake.settled
	s.askPageToReload(func() {})
	select {
	case err := <-result:
		t.Fatalf("the reload request ended the presented wait of an endpoint request: %v", err)
	default:
	}
	s.endWindow()
	wantEnd(t, result, windowClosedEnd, "the presented wait of an endpoint request")
}
