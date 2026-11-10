package host

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// pageEndWindow is a window whose page a test ends: it holds the listeners of its window events and the hook of its close, and
// sends each event that the host sends to its page, each close and each start of its workbench to sent.
type pageEndWindow struct {
	closingWindow
	listeners map[WindowEvent][]func()
	sent      chan string
	mu        sync.Mutex
	closes    int
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
func (w *pageEndWindow) waitSent(t *testing.T, name string) {
	t.Helper()
	for got := range w.sent {
		if got == name {
			return
		}
	}
}

// pageEndPlatform answers the native calls of a window whose page starts, ends and closes.
type pageEndPlatform struct{ closingPlatform }

func (p *pageEndPlatform) ModalHoldEnd(platform.Window) {}

// pageEndFixture is a host with one window whose page is ready.
func pageEndFixture(t *testing.T) (*Host, *Surfaces, *pageEndWindow) {
	t.Helper()
	window := &pageEndWindow{closingWindow: closingWindow{elementWindow: elementWindow{pagelessWindow: pagelessWindow{native: platform.Window(1)}}},
		listeners: map[WindowEvent][]func(){}, sent: make(chan string, 64)}
	previousFramework, previousSystem := framework, system
	framework, system = pagelessFramework{window: window}, &pageEndPlatform{}
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	h := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, sidecars: &Sidecars{}, quit: &Quit{}, relay: NewRelay[relayTarget]()}
	s := h.newWindow("main", "")
	h.mu.Lock()
	s.ready = true
	h.mu.Unlock()
	return h, s, window
}

// askPage sends a command request to the page of s without a limit and returns the channel of its error.
func askPage(t *testing.T, h *Host, s *Surfaces, window *pageEndWindow) <-chan error {
	t.Helper()
	reply := make(chan error, 1)
	go func() {
		_, err := h.ask(context.Background(), s, "command.run", map[string]any{"name": "core.probe", "params": map[string]any{}})
		reply <- err
	}()
	window.waitSent(t, "exposure-request")
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
	window.waitSent(t, "project-close-request")
	window.end()
	if window.closeCount() != 1 {
		t.Fatalf("the end of the page closed the window %d times, want once", window.closeCount())
	}
	window.end()
	if window.closeCount() != 1 {
		t.Fatalf("a second end closed the window again: %d closes", window.closeCount())
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
	window.waitSent(t, "start")
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
	s.invoke = func(task func()) { task() }
	s.reloadCancelLayout = func() error { return errors.New("the layout cannot be cancelled") }
	s.reloadKeysPageEnded = func() {}
	s.reloadHideSurface = func(unsafe.Pointer, bool) {}
	s.reloadCloseImage = func(unsafe.Pointer) {}
	reloaded := make(chan error, 1)
	go func() { reloaded <- s.reloadPage() }()
	window.waitSent(t, "start")
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
