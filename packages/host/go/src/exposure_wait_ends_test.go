package host

import (
	"errors"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// pendingSettledPlatform is the platform of a settled wait whose screen never presents: its settled wait answers nothing.
type pendingSettledPlatform struct{ platform.Platform }

func (pendingSettledPlatform) AfterSettled(platform.Window, unsafe.Pointer, func(float64, error)) error { return nil }

// presentedResult runs host.window.presented of s and returns the channel of its result.
func presentedResult(s *Surfaces) <-chan error {
	result := make(chan error, 1)
	go func() {
		_, err := s.presented()
		result <- err
	}()
	return result
}

// expectRPCCode waits for err on result and checks its endpoint code.
func expectRPCCode(t *testing.T, result <-chan error, code int, what string) *RPCError {
	t.Helper()
	select {
	case err := <-result:
		var rpc *RPCError
		if !errors.As(err, &rpc) || rpc.Code != code {
			t.Fatalf("%s ended with %v, want the code %d", what, err, code)
		}
		return rpc
	case <-time.After(2 * time.Second):
		t.Fatalf("%s is still waiting", what)
	}
	return nil
}

// A window that closes while host.window.presented waits for its settled screen ends the wait with 1003; the wait has no
// limit of its own.
// contract: exposure.window-presented.ends-by-events
func TestTheCloseOfTheWindowEndsAPresentedWait(t *testing.T) {
	native := platform.Window(1)
	s := settledSurfaces(t, &settledFrontend{window: native, present: func() {}}, nil)
	saved := system
	system = pendingSettledPlatform{}
	t.Cleanup(func() { system = saved })
	result := presentedResult(s)
	select {
	case err := <-result:
		t.Fatalf("the presented wait ended before its screen presented: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	s.endWindow()
	expectRPCCode(t, result, codeNoWindow, "the presented wait of a closed window")
}

// The end of the WebContent process of an open modal that has not painted ends the paint wait of host.window.presented
// with a failure.
// contract: exposure.window-presented.ends-by-events
func TestTheEndOfTheProcessOfAnOpenModalEndsItsPaintWait(t *testing.T) {
	native := platform.Window(1)
	s := settledSurfaces(t, &settledFrontend{window: native, present: func() {}}, &settledPlatform{window: native, displayed: 4})
	s.modalPaintChange = make(chan struct{})
	handle := unsafe.Pointer(new(int))
	const viewID = 876543
	view := &nativeWebview{owner: s, id: viewID, handle: handle}
	nativeViews[viewID] = view
	t.Cleanup(func() { delete(nativeViews, viewID) })
	s.modal = &modal{id: "modal-a", instance: 3, shown: true, visible: true, view: view}
	result := presentedResult(s)
	select {
	case err := <-result:
		t.Fatalf("the presented wait ended before the modal painted or ended: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	terminatedNative(viewID)
	expectRPCCode(t, result, codeHandler, "the presented wait of a modal whose process ended")
}

// fullscreenPlatform is the platform of a full screen test: its change answers result and message at once.
type fullscreenPlatform struct {
	platform.Platform
	result  platform.FullscreenResult
	message string
}

func (p fullscreenPlatform) Fullscreen(_ platform.Window, _ bool, done func(platform.FullscreenResult, string)) error {
	done(p.result, p.message)
	return nil
}

// host.window.fullscreen answers once with the result of the native change: a refusal is 1006, the close of the window
// is 1003 and a started transition that did not end is 1005, each with the native message.
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
		{platform.FullscreenUnended, "the full screen transition did not end within 10s", codeTimeout},
	}
	for _, c := range cases {
		t.Run(c.message, func(t *testing.T) {
			native := platform.Window(1)
			s := settledSurfaces(t, &settledFrontend{window: native}, nil)
			saved := system
			system = fullscreenPlatform{result: c.result, message: c.message}
			t.Cleanup(func() { system = saved })
			result := make(chan error, 1)
			go func() { result <- s.fullscreen(true) }()
			rpc := expectRPCCode(t, result, c.code, "the full screen change")
			if rpc.Message != c.message {
				t.Fatalf("the full screen change failed with %q, want the native message %q", rpc.Message, c.message)
			}
		})
	}
	native := platform.Window(1)
	s := settledSurfaces(t, &settledFrontend{window: native}, nil)
	saved := system
	system = fullscreenPlatform{result: platform.FullscreenDone}
	t.Cleanup(func() { system = saved })
	if err := s.fullscreen(false); err != nil {
		t.Fatalf("a finished transition failed: %v", err)
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
			savedFramework := framework
			framework = stepFramework{}
			t.Cleanup(func() { framework = savedFramework })
			window := &reloadingWindow{started: make(chan struct{})}
			s := &Surfaces{host: &Host{relay: NewRelay[relayTarget]()}, window: window}
			result := make(chan error, 1)
			go func() { result <- s.reloadPage() }()
			select {
			case <-window.started:
			case <-time.After(2 * time.Second):
				t.Fatal("the reload did not start the workbench")
			}
			select {
			case err := <-result:
				t.Fatalf("the reload ended before its page reported ready or ended: %v", err)
			case <-time.After(50 * time.Millisecond):
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
