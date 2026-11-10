package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
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

// modalKeyboardPlatform is the platform of a modal keyboard test: it records the calls that concern the keyboard of the window in
// their order, and creates a web view that loads, or refuses it when refuse is set.
type modalKeyboardPlatform struct {
	platform.Platform
	calls  []string
	refuse bool
	paint  func()
}

func (p *modalKeyboardPlatform) AlignRect(_ platform.Window, at platform.Rect) (platform.Rect, float64, error) {
	return at, 1, nil
}

func (p *modalKeyboardPlatform) CreateWebview(platform.Window, platform.WebviewOptions) (unsafe.Pointer, error) {
	if p.refuse {
		return nil, errors.New("refused")
	}
	return unsafe.Pointer(new(int)), nil
}

func (*modalKeyboardPlatform) NavigateWebview(unsafe.Pointer, string) bool    { return true }
func (*modalKeyboardPlatform) ConfigureModal(unsafe.Pointer, string, float64) {}
func (*modalKeyboardPlatform) SetWebviewHidden(unsafe.Pointer, bool)          {}
func (*modalKeyboardPlatform) CloseWebview(unsafe.Pointer)                    {}
func (*modalKeyboardPlatform) EvaluateScript(unsafe.Pointer, string)          {}
func (p *modalKeyboardPlatform) ModalHold(platform.Window)                    { p.calls = append(p.calls, "hold") }
func (p *modalKeyboardPlatform) ModalHoldEnd(platform.Window)                 { p.calls = append(p.calls, "end") }
func (p *modalKeyboardPlatform) FocusModal(_ unsafe.Pointer, take bool) {
	p.calls = append(p.calls, fmt.Sprintf("focus %t", take))
}

// AfterViewPresentation records the start of the first-paint wait of the revealed modal and holds the callback, so a
// test paints the modal when it chooses. paint holds the callback of the last wait.
func (p *modalKeyboardPlatform) AfterViewPresentation(_ unsafe.Pointer, presented func()) bool {
	p.calls = append(p.calls, "paint")
	p.paint = presented
	return true
}

// modalFrontend is the window of a modal keyboard test: it takes the events and the workbench calls of the host.
type modalFrontend struct{ noticeFrontend }

func (*modalFrontend) Emit(string, ...any)  {}
func (*modalFrontend) CallWorkbench(string) {}

func modalKeyboardSurfaces(t *testing.T, refuse bool) (*Surfaces, *modalKeyboardPlatform) {
	t.Helper()
	fake := &modalKeyboardPlatform{refuse: refuse}
	savedSystem, savedFramework := system, framework
	system, framework = fake, stepFramework{}
	t.Cleanup(func() { system, framework = savedSystem, savedFramework })
	s := &Surfaces{window: &modalFrontend{}, documents: NewDocuments(), images: NewImages(), modalPaintChange: make(chan struct{}),
		invoke: func(task func()) { task() }}
	return s, fake
}

func showPicker(t *testing.T, s *Surfaces, id string) {
	t.Helper()
	if _, err := s.OverlayShow(OverlayRequest{ID: id, Mode: "menu", Rect: Rect{W: 10, H: 10}}); err != nil {
		t.Fatalf("OverlayShow %s: %v", id, err)
	}
}

// contract: modal.keyboard-hold
func TestTheInputWaitsFromTheShowOfAModalUntilItTakesTheKeyboard(t *testing.T) {
	s, fake := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	if want := []string{"hold"}; !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("the show of a modal made the calls %v, want %v: the input of the window waits until the modal takes the keyboard", fake.calls, want)
	}
	if err := s.ModalReady("picker", s.modal.instance); err != nil {
		t.Fatalf("ModalReady: %v", err)
	}
	if want := []string{"hold", "focus true", "end", "paint"}; !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("the ready modal made the calls %v, want %v: the input that waited reaches the modal after it took the keyboard", fake.calls, want)
	}
}

// contract: modal.keyboard-hold
func TestAModalThatClosesOrFailsBeforeItTookTheKeyboardEndsTheWait(t *testing.T) {
	s, fake := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	if err := s.OverlayHide("picker"); err != nil {
		t.Fatalf("OverlayHide: %v", err)
	}
	if want := []string{"hold", "focus false", "end"}; !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("a modal closed before it was ready made the calls %v, want %v", fake.calls, want)
	}

	started, discarded := modalKeyboardSurfaces(t, false)
	showPicker(t, started, "picker")
	started.discardOverlay()
	if want := []string{"hold", "end"}; !reflect.DeepEqual(discarded.calls, want) {
		t.Fatalf("a main page that started under a modal that was not ready made the calls %v, want %v", discarded.calls, want)
	}

	failed, refused := modalKeyboardSurfaces(t, true)
	if _, err := failed.OverlayShow(OverlayRequest{ID: "picker", Mode: "menu", Rect: Rect{W: 10, H: 10}}); err == nil {
		t.Fatalf("OverlayShow of a refused web view answered no error")
	}
	if want := []string{"hold", "end"}; !reflect.DeepEqual(refused.calls, want) {
		t.Fatalf("a failed show made the calls %v, want %v: no input waits for a modal that does not exist", refused.calls, want)
	}
}

// contract: modal.keyboard-hold
func TestTheEndOfTheProcessOfAModalDocumentEndsTheWait(t *testing.T) {
	s, fake := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	view := s.modal.view
	t.Cleanup(func() { delete(nativeViews, view.id) })
	terminatedNative(view.id)
	if want := []string{"hold", "end"}; !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("the end of the process of a modal document that was not ready made the calls %v, want %v: no key waits for a modal whose document ended", fake.calls, want)
	}
}

// contract: modal.keyboard-hold
func TestAModalThatReplacesAnotherKeepsTheWaitUntilItTakesTheKeyboard(t *testing.T) {
	s, fake := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	showPicker(t, s, "menu")
	if want := []string{"hold", "hold", "focus false"}; !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("a show that replaced a modal made the calls %v, want %v: the wait stands from the first show until the second modal takes the keyboard", fake.calls, want)
	}
	if err := s.ModalReady("menu", s.modal.instance); err != nil {
		t.Fatalf("ModalReady: %v", err)
	}
	if want := []string{"hold", "hold", "focus false", "focus true", "end", "paint"}; !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("the ready replacement made the calls %v, want %v", fake.calls, want)
	}
}

// The first-frame wait of the shown modal takes no time limit: the first frame of the modal ends it, the close of the modal
// ends it, and no open modal holds no wait. Each end is a change of the modal state that the wait reads, so an end before
// the wait reads it ends the wait the same way.
// contract: exposure.window-presented.ends-by-events
func TestThePresentedWaitEndsAtThePaintOfTheShownModal(t *testing.T) {
	s, fake := modalKeyboardSurfaces(t, false)
	showPicker(t, s, "picker")
	if err := s.ModalReady("picker", s.modal.instance); err != nil {
		t.Fatalf("ModalReady: %v", err)
	}
	ended := make(chan error, 1)
	go func() { ended <- s.waitForModalPaint(context.Background()) }()
	fake.paint()
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
