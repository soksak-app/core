package host

import (
	"context"
	"errors"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// presentedResult runs host.window.presented of s and returns the channel of its result.
func presentedResult(s *Surfaces) <-chan error {
	return presentedResultOf(context.Background(), s)
}

// presentedResultOf runs host.window.presented of s for a request of the endpoint connection ctx and returns the channel
// of its result.
func presentedResultOf(ctx context.Context, s *Surfaces) <-chan error {
	result := make(chan error, 1)
	go func() {
		_, err := s.presented(ctx)
		result <- err
	}()
	return result
}

// expectRPCCode receives err from result and checks its endpoint code. A wait that does not end is reported by the limit
// of the test run.
func expectRPCCode(t *testing.T, result <-chan error, code int, what string) *RPCError {
	t.Helper()
	err := <-result
	var rpc *RPCError
	if !errors.As(err, &rpc) || rpc.Code != code {
		t.Fatalf("%s ended with %v, want the code %d", what, err, code)
	}
	return rpc
}

// A window that closes while host.window.presented waits for its settled screen ends the wait with 1003; the wait has no
// limit of its own.
// contract: exposure.window-presented.ends-by-events
func TestTheCloseOfTheWindowEndsAPresentedWait(t *testing.T) {
	s := realSettledSurfaces(t, true)
	native := s.window.NativeWindow()
	// The settled screen of a window with an open layout transaction presents after the transaction ends, so the wait stays open.
	var opened error
	runOnMainThread(func() { _, opened = beginLayout(native, 1) })
	if opened != nil {
		t.Fatal(opened)
	}
	t.Cleanup(func() { runOnMainThread(func() { system.CancelLayout(native) }) })
	result := presentedResult(s)
	s.endWindow()
	expectRPCCode(t, result, codeNoWindow, "the presented wait of a closed window")
}

// The end of the WebContent process of an open modal that has not painted ends the paint wait of host.window.presented
// with a failure. The paint wait calls nothing that marks its start, so the end is order-insensitive: an end recorded before
// the wait reaches the modal ends it the same way, and the test sends the end right after it starts the wait.
// contract: exposure.window-presented.ends-by-events
func TestTheEndOfTheProcessOfAnOpenModalEndsItsPaintWait(t *testing.T) {
	s := realSettledSurfaces(t, true)
	s.modalPaintChange = make(chan struct{})
	handle := unsafe.Pointer(new(int))
	const viewID = 876543
	view := &nativeWebview{owner: s, id: viewID, handle: handle}
	nativeViews[viewID] = view
	t.Cleanup(func() { delete(nativeViews, viewID) })
	s.modal = &modal{id: "modal-a", instance: 3, shown: true, visible: true, view: view}
	result := presentedResult(s)
	terminatedNative(viewID)
	expectRPCCode(t, result, codeHandler, "the presented wait of a modal whose process ended")
}

// unpaintedModalSurfaces returns surfaces of a window whose settled screen presents at once and whose shown modal has
// not presented its first frame.
func unpaintedModalSurfaces(t *testing.T) *Surfaces {
	t.Helper()
	s := realSettledSurfaces(t, true)
	s.modalPaintChange = make(chan struct{})
	handle := unsafe.Pointer(new(int))
	const viewID = 876544
	view := &nativeWebview{owner: s, id: viewID, handle: handle}
	nativeViews[viewID] = view
	t.Cleanup(func() { delete(nativeViews, viewID) })
	s.modal = &modal{id: "modal-b", instance: 4, shown: true, visible: true, view: view}
	return s
}

// The close of the window and the end of the process of its main page fail host.window.presented with 1003 while it waits
// for the first frame of the shown modal, and the end of the endpoint connection of the request ends it with an error.
// Each end is recorded in the window, so an end before the wait reaches the modal ends it the same way.
// contract: exposure.window-presented.ends-by-events
func TestTheWindowThePageAndTheConnectionEndThePaintWaitOfPresented(t *testing.T) {
	t.Run("window close", func(t *testing.T) {
		s := unpaintedModalSurfaces(t)
		result := presentedResult(s)
		s.endWindow()
		expectRPCCode(t, result, codeNoWindow, "the presented wait of a closed window with an unpainted modal")
	})
	t.Run("main page process end", func(t *testing.T) {
		s := unpaintedModalSurfaces(t)
		result := presentedResult(s)
		s.pageProcessEnded()
		expectRPCCode(t, result, codeNoWindow, "the presented wait of an ended main page with an unpainted modal")
	})
	t.Run("connection end", func(t *testing.T) {
		s := unpaintedModalSurfaces(t)
		ctx, end := context.WithCancel(context.Background())
		result := presentedResultOf(ctx, s)
		end()
		if err := <-result; err == nil {
			t.Fatal("the presented wait whose connection ended answered a result")
		}
	})
}

// host.window.fullscreen answers once with the result of the native change: a refusal is 1006, the close of the window is 1003 and a
// started transition that did not end is 1005, each with the native message.
// contract: exposure.fullscreen.answers-once-by-its-event
func TestTheFullScreenChangeAnswersWithItsNativeResult(t *testing.T) {
	cases := []struct {
		result  platform.FullscreenResult
		message string
		code    int
	}{
		{platform.FullscreenRefused, "the window is minimized", codeInactive},
		{platform.FullscreenRefused, "macOS did not start the full screen transition", codeInactive},
		{platform.FullscreenClosed, "the window closed during the full screen transition", codeNoWindow},
		{platform.FullscreenFailed, "macOS failed the full screen transition", codeTimeout},
	}
	for _, c := range cases {
		t.Run(c.message, func(t *testing.T) {
			var rpc *RPCError
			if err := fullscreenAnswer(c.result, c.message); !errors.As(err, &rpc) || rpc.Code != c.code || rpc.Message != c.message {
				t.Fatalf("the full screen change answered %v, want the code %d with the native message %q", err, c.code, c.message)
			}
		})
	}
	if err := fullscreenAnswer(platform.FullscreenDone, ""); err != nil {
		t.Fatalf("a finished transition failed: %v", err)
	}
}

// The window of the real platform that no one showed refuses the change with the message of the native layer, which the command answers
// with its code.
// contract: exposure.fullscreen.answers-once-by-its-event
func TestTheFullScreenChangeOfAWindowThatIsNotShownIsRefused(t *testing.T) {
	s := realSettledSurfaces(t, true)
	var rpc *RPCError
	if err := s.fullscreen(true); !errors.As(err, &rpc) || rpc.Code != codeInactive || rpc.Message != "the window is not shown" {
		t.Fatalf("the full screen change of a window that is not shown answered %v, want 1006 with the native message", err)
	}
}

// reloadingWindow is the window of a reload test whose workbench has not reported ready: the host starts it again itself.
type reloadingWindow struct {
	frontendRecord
	started chan struct{}
}

func (w *reloadingWindow) Name() string    { return "main" }
func (w *reloadingWindow) StartWorkbench() { close(w.started) }

// A reload ends at the close of its window and at the end of its page process before the new page reports ready, each with
// 1003 that names the end and the running calls; it has no limit.
// contract: reload.ends-by-ready-close-or-process-end
func TestAReloadEndsAtTheCloseOfItsWindowOrTheEndOfItsPageProcess(t *testing.T) {
	for _, end := range []string{"the window closed", "the page process ended"} {
		t.Run(end, func(t *testing.T) {
			useStepFramework(t)
			window := &reloadingWindow{started: make(chan struct{})}
			s := &Surfaces{host: &Host{relay: NewRelay[relayTarget]()}, window: window}
			result := make(chan error, 1)
			go func() { result <- s.reloadPage() }()
			<-window.started
			select {
			case err := <-result:
				t.Fatalf("the reload ended when it started the workbench, before its page reported ready or ended: %v", err)
			default:
			}
			if end == "the window closed" {
				s.endWindow()
			} else {
				s.pageProcessEnded()
			}
			rpc := expectRPCCode(t, result, codeNoWindow, "the reload")
			if want := ReloadEndText(end, "none"); rpc.Message != want {
				t.Fatalf("the reload failed with %q, want %q", rpc.Message, want)
			}
		})
	}
}

// A reload that begins after the end of the page process of its window is not ended by that end: the reload starts a new page,
// which is how that window recovers, so it waits for the ready of that page and ends at a later end of the window.
// contract: reload.ends-by-ready-close-or-process-end
func TestAReloadAfterTheEndOfItsPageProcessStartsTheNewPage(t *testing.T) {
	useStepFramework(t)
	window := &reloadingWindow{started: make(chan struct{})}
	s := &Surfaces{host: &Host{relay: NewRelay[relayTarget]()}, window: window}
	s.pageProcessEnded()
	result := make(chan error, 1)
	go func() { result <- s.reloadPage() }()
	<-window.started
	select {
	case err := <-result:
		t.Fatalf("the end of the page process before the reload ended the reload: %v", err)
	default:
	}
	s.endWindow()
	rpc := expectRPCCode(t, result, codeNoWindow, "the reload")
	if want := ReloadEndText("the window closed", "none"); rpc.Message != want {
		t.Fatalf("the reload failed with %q, want %q", rpc.Message, want)
	}
}
