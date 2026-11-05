package host

import (
	"errors"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// settledFrontend is the window of a settled wait test: its settled presentation is a function that stands for the block.
type settledFrontend struct {
	frontendRecord
	window    unsafe.Pointer
	present   func()
	presented error
}

func (f *settledFrontend) NativeWindow() unsafe.Pointer { return f.window }

func (f *settledFrontend) SettledPresentation() (unsafe.Pointer, error) {
	if f.presented != nil {
		return nil, f.presented
	}
	return unsafe.Pointer(&f.present), nil
}

// settledPlatform is the platform of a settled wait test: its settled wait runs the block that it takes on the window, and
// reports the time of the screen.
type settledPlatform struct {
	platform.Platform
	window    unsafe.Pointer
	displayed float64
	failure   error
	waits     int
}

func (p *settledPlatform) AfterSettled(window, present unsafe.Pointer, done func(displayed float64, err error)) error {
	p.waits++
	if window != p.window {
		done(0, errors.New("the settled wait took another window"))
		return nil
	}
	(*(*func())(present))()
	done(p.displayed, p.failure)
	return nil
}

func settledSurfaces(t *testing.T, window *settledFrontend, fake *settledPlatform) *Surfaces {
	t.Helper()
	saved, savedFramework := system, framework
	system, framework = fake, stepFramework{}
	t.Cleanup(func() { system, framework = saved, savedFramework })
	return &Surfaces{window: window, images: NewImages()}
}

// The settled wait brings the content to the screen through the settled presentation of the Frontend.
// contract: exposure.settled-wait.presents-through-the-frontend
func TestSettledWaitBringsTheContentThroughTheFrontend(t *testing.T) {
	native := unsafe.Pointer(new(int))
	var brought int
	window := &settledFrontend{window: native, present: func() { brought++ }}
	fake := &settledPlatform{window: native, displayed: 12.5}
	displayed, err := settledSurfaces(t, window, fake).presented()
	if err != nil {
		t.Fatalf("the settled wait failed: %v", err)
	}
	if displayed != 12.5 {
		t.Fatalf("the settled wait reported %v, want the time of the screen", displayed)
	}
	if brought == 0 || brought != fake.waits {
		t.Fatalf("the block ran %d times in %d settled waits", brought, fake.waits)
	}
}

// A settled presentation that the Frontend cannot make ends the wait with its error, before the settled wait of the platform.
// contract: exposure.settled-wait.presents-through-the-frontend
func TestSettledWaitEndsWithTheFailureOfTheFrontend(t *testing.T) {
	refused := errors.New("the main web view is gone")
	fake := &settledPlatform{}
	_, err := settledSurfaces(t, &settledFrontend{presented: refused}, fake).presented()
	if !errors.Is(err, refused) {
		t.Fatalf("the settled wait ended with %v, want the error of the Frontend", err)
	}
	if fake.waits != 0 {
		t.Fatalf("the platform waited %d times without a presentation", fake.waits)
	}
}

// The failure of the block ends the settled wait.
// contract: exposure.settled-wait.presents-through-the-frontend
func TestSettledWaitEndsWithTheFailureOfThePresentation(t *testing.T) {
	native := unsafe.Pointer(new(int))
	failed := errors.New("the document did not finish")
	window := &settledFrontend{window: native, present: func() {}}
	_, err := settledSurfaces(t, window, &settledPlatform{window: native, failure: failed}).presented()
	if !errors.Is(err, failed) {
		t.Fatalf("the settled wait ended with %v, want the failure of the block", err)
	}
}
