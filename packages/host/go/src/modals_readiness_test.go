package host

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"slices"
	"sync"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// contract: modal.ready-visible
func TestAStaleModalReadyChangesNothingAndWritesTheTrace(t *testing.T) {
	isolateTraceRecords(t)
	s := &Surfaces{}
	if err := s.ModalReady("debug", 7); err != nil {
		t.Fatalf("a ready request of a modal that is not open answered %v, want nil", err)
	}
	if s.modal != nil {
		t.Fatalf("a stale ready request opened a modal record %+v", s.modal)
	}

	records.Lock()
	defer records.Unlock()
	for _, record := range records.buffer {
		if record.event != "host.trace.modal.stale-ready" {
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal(record.fields, &fields); err != nil {
			t.Fatalf("the fields of the stale ready trace cannot be read: %v", err)
		}
		want := map[string]any{"modal": "debug", "instance": float64(7)}
		if !reflect.DeepEqual(fields, want) {
			t.Fatalf("the stale ready trace has fields %v, want %v", fields, want)
		}
		return
	}
	t.Fatalf("no host.trace.modal.stale-ready record was written; the buffered records are %d", len(records.buffer))
}

// modalCalls is the platform of the operating system that records the calls that concern the keyboard of the window in their order.
// Each call goes on to the platform of the operating system, and the first-paint wait runs on the main thread, where the framework
// of a window calls it.
type modalCalls struct {
	platform.Platform
	mu    sync.Mutex
	calls []string
}

func (p *modalCalls) record(call string) {
	p.mu.Lock()
	p.calls = append(p.calls, call)
	p.mu.Unlock()
}

func (p *modalCalls) recorded() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.calls)
}

func (p *modalCalls) ModalHold(window platform.Window) {
	p.record("hold")
	p.Platform.ModalHold(window)
}

func (p *modalCalls) ModalHoldEnd(window platform.Window) {
	p.record("end")
	p.Platform.ModalHoldEnd(window)
}

func (p *modalCalls) FocusModal(view unsafe.Pointer, take bool) {
	p.record(fmt.Sprintf("focus %t", take))
	p.Platform.FocusModal(view, take)
}

func (p *modalCalls) AfterViewPresentation(view unsafe.Pointer, presented func()) bool {
	p.record("paint")
	var started bool
	stepOnMainThread(func() { started = p.Platform.AfterViewPresentation(view, presented) })
	return started
}

// modalFrontend is the window of a modal keyboard test: it takes the events and the workbench calls of the host and names its
// native window.
type modalFrontend struct {
	noticeFrontend
	native platform.Window
}

func (f *modalFrontend) NativeWindow() platform.Window { return f.native }
func (*modalFrontend) Emit(string, ...any)             {}
func (*modalFrontend) CallWorkbench(string)            {}

// modalFramework is a framework whose steps run on the main thread of the native library.
type modalFramework struct{ frameworkRecord }

func (modalFramework) Step(task func()) { stepOnMainThread(task) }

// modalKeyboardSurfaces returns the surfaces of a window of the platform of the operating system, which has a main web view that a modal
// web view is placed over. A window without a main web view is a window in which the platform refuses to create a modal web view, which
// refuse selects. The modal and the window close with the test.
func modalKeyboardSurfaces(t *testing.T, refuse bool) (*Surfaces, *modalCalls) {
	t.Helper()
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	var native platform.Window
	if refuse {
		native = support.TitledWindow(t, runOnMainThread, 400, 300)
	} else {
		native = support.TitledWindowWithMainPage(t, runOnMainThread, 400, 300, "main-page.html")
	}
	calls := &modalCalls{Platform: current}
	savedSystem, savedFramework := system, framework
	system, framework = calls, modalFramework{}
	t.Cleanup(func() { system, framework = savedSystem, savedFramework })
	s := &Surfaces{window: &modalFrontend{native: native}, documents: NewDocuments(), images: NewImages(), modalPaintChange: make(chan struct{}),
		invoke: stepOnMainThread}
	t.Cleanup(s.discardOverlay)
	return s, calls
}

// holdFirstPaint sets the fault point that holds the first paint of each web view until the test releases it, and releases what is
// held when the test ends.
func holdFirstPaint(t *testing.T) {
	t.Helper()
	t.Setenv("SOKSAK_FAULT_VIEW_PRESENTATION", "hold")
	t.Cleanup(func() { support.ReleaseHeldPresentations(t) })
}

func showPicker(t *testing.T, s *Surfaces, id string) {
	t.Helper()
	if _, err := s.OverlayShow(OverlayRequest{ID: id, Mode: "menu", Rect: Rect{W: 10, H: 10}}); err != nil {
		t.Fatalf("OverlayShow %s: %v", id, err)
	}
}

// contract: modal.keyboard-hold
func TestTheInputWaitsFromTheShowOfAModalUntilItTakesTheKeyboard(t *testing.T) {
	s, calls := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	if want := []string{"hold"}; !reflect.DeepEqual(calls.recorded(), want) {
		t.Fatalf("the show of a modal made the calls %v, want %v: the input of the window waits until the modal takes the keyboard", calls.recorded(), want)
	}
	if err := s.ModalReady("picker", s.modal.instance); err != nil {
		t.Fatalf("ModalReady: %v", err)
	}
	if want := []string{"hold", "focus true", "end", "paint"}; !reflect.DeepEqual(calls.recorded(), want) {
		t.Fatalf("the ready modal made the calls %v, want %v: the input that waited reaches the modal after it took the keyboard", calls.recorded(), want)
	}
}

// contract: modal.keyboard-hold
func TestAModalThatClosesOrFailsBeforeItTookTheKeyboardEndsTheWait(t *testing.T) {
	s, calls := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	if err := s.OverlayHide("picker"); err != nil {
		t.Fatalf("OverlayHide: %v", err)
	}
	if want := []string{"hold", "focus false", "end"}; !reflect.DeepEqual(calls.recorded(), want) {
		t.Fatalf("a modal closed before it was ready made the calls %v, want %v", calls.recorded(), want)
	}

	started, discarded := modalKeyboardSurfaces(t, false)
	showPicker(t, started, "picker")
	started.discardOverlay()
	if want := []string{"hold", "end"}; !reflect.DeepEqual(discarded.recorded(), want) {
		t.Fatalf("a main page that started under a modal that was not ready made the calls %v, want %v", discarded.recorded(), want)
	}

	failed, refused := modalKeyboardSurfaces(t, true)
	if _, err := failed.OverlayShow(OverlayRequest{ID: "picker", Mode: "menu", Rect: Rect{W: 10, H: 10}}); err == nil {
		t.Fatalf("OverlayShow of a refused web view answered no error")
	}
	if want := []string{"hold", "end"}; !reflect.DeepEqual(refused.recorded(), want) {
		t.Fatalf("a failed show made the calls %v, want %v: no input waits for a modal that does not exist", refused.recorded(), want)
	}
}

// contract: modal.keyboard-hold
func TestTheEndOfTheProcessOfAModalDocumentEndsTheWait(t *testing.T) {
	s, calls := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	view := s.modal.view
	t.Cleanup(func() { delete(nativeViews, view.id) })
	terminatedNative(view.id)
	if want := []string{"hold", "end"}; !reflect.DeepEqual(calls.recorded(), want) {
		t.Fatalf("the end of the process of a modal document that was not ready made the calls %v, want %v: no key waits for a modal whose document ended", calls.recorded(), want)
	}
}

// contract: modal.keyboard-hold
func TestAModalThatReplacesAnotherKeepsTheWaitUntilItTakesTheKeyboard(t *testing.T) {
	s, calls := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	showPicker(t, s, "menu")
	if want := []string{"hold", "hold", "focus false"}; !reflect.DeepEqual(calls.recorded(), want) {
		t.Fatalf("a show that replaced a modal made the calls %v, want %v: the wait stands from the first show until the second modal takes the keyboard", calls.recorded(), want)
	}
	if err := s.ModalReady("menu", s.modal.instance); err != nil {
		t.Fatalf("ModalReady: %v", err)
	}
	if want := []string{"hold", "hold", "focus false", "focus true", "end", "paint"}; !reflect.DeepEqual(calls.recorded(), want) {
		t.Fatalf("the ready replacement made the calls %v, want %v", calls.recorded(), want)
	}
}

// The first-frame wait of the shown modal takes no time limit: the first frame of the modal ends it, the close of the modal
// ends it, and no open modal holds no wait. Each end is a change of the modal state that the wait reads, so an end before
// the wait reads it ends the wait the same way.
// contract: exposure.window-presented.ends-by-events
func TestThePresentedWaitEndsAtThePaintOfTheShownModal(t *testing.T) {
	holdFirstPaint(t)
	s, _ := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	if err := s.ModalReady("picker", s.modal.instance); err != nil {
		t.Fatalf("ModalReady: %v", err)
	}
	ended := make(chan error, 1)
	go func() { ended <- s.waitForModalPaint(context.Background()) }()
	support.ReleaseHeldPresentations(t)
	if err := <-ended; err != nil {
		t.Fatalf("the first frame of the modal ended the wait with %v", err)
	}
	showPicker(t, s, "picker")
	if err := s.ModalReady("picker", s.modal.instance); err != nil {
		t.Fatalf("ModalReady of the second modal: %v", err)
	}
	go func() { ended <- s.waitForModalPaint(context.Background()) }()
	if err := s.OverlayHide("picker"); err != nil {
		t.Fatalf("OverlayHide: %v", err)
	}
	if err := <-ended; err != nil {
		t.Fatalf("the close of the modal ended the wait with %v", err)
	}
	if err := s.waitForModalPaint(context.Background()); err != nil {
		t.Fatalf("no open modal ended the wait with %v", err)
	}
}

// The end of the endpoint connection of the request ends the first-frame wait of the shown modal and leaves the modal
// open. A connection that ended before the wait ends it the same way.
// contract: exposure.window-presented.ends-by-events
func TestTheEndOfTheConnectionEndsThePaintWaitOfTheShownModal(t *testing.T) {
	holdFirstPaint(t)
	s, _ := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	if err := s.ModalReady("picker", s.modal.instance); err != nil {
		t.Fatalf("ModalReady: %v", err)
	}
	ctx, end := context.WithCancel(context.Background())
	ended := make(chan error, 1)
	go func() { ended <- s.waitForModalPaint(ctx) }()
	end()
	if err := <-ended; err == nil {
		t.Fatal("the end of the connection ended the wait without an error")
	}
	if s.modal == nil {
		t.Fatal("the end of the connection closed the modal")
	}
}

// The fault point holds the first paint of a web view after its real presentation update until the release, so the wait of the first
// paint of a shown modal ends by the release and not by the speed of the system.
// contract: verification.native-test-facade.held-first-paint-ends-by-release
func TestAHeldFirstPaintOfTheShownModalEndsByTheRelease(t *testing.T) {
	holdFirstPaint(t)
	s, _ := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	if err := s.ModalReady("picker", s.modal.instance); err != nil {
		t.Fatalf("ModalReady: %v", err)
	}
	// A later wait of the same view without the fault point ends at the update that the held wait also saw, so the held callback is
	// past its update when this wait returns.
	view := s.modal.view.handle
	if err := os.Unsetenv("SOKSAK_FAULT_VIEW_PRESENTATION"); err != nil {
		t.Fatal(err)
	}
	updated := make(chan struct{})
	if !system.AfterViewPresentation(view, func() { close(updated) }) {
		t.Fatal("the platform started no presentation wait of the modal view")
	}
	<-updated
	s.mu.Lock()
	painted := s.modal.painted
	s.mu.Unlock()
	if painted {
		t.Fatal("the modal painted while its first paint was held")
	}
	ended := make(chan error, 1)
	go func() { ended <- s.waitForModalPaint(context.Background()) }()
	support.ReleaseHeldPresentations(t)
	if err := <-ended; err != nil {
		t.Fatalf("the release of the first paint ended the wait with %v", err)
	}
}
