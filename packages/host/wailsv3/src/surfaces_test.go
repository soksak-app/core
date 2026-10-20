package host

import (
	"errors"
	"testing"
	"unsafe"
)

// contract: exposure.host-window.reads-during-surface-close
func TestSurfaceNameIsForgottenInTheStepThatClosesItsNativeView(t *testing.T) {
	s := &Surfaces{named: map[uintptr]string{}}
	// A view without a native handle closes without calling the native code.
	view := &nativeWebview{owner: s}
	s.named[uintptr(view.handle)] = "tab-2"
	namesAfterStep := -1
	// The step runs at once, as the UI thread would run it. The names are read after the step returns, which is when a
	// window status reading on the UI thread that follows the close would see them.
	run := func(step func()) {
		step()
		namesAfterStep = len(s.named)
	}
	s.closeRegisteredSurface(run, view)
	if namesAfterStep != 0 {
		t.Fatalf("names after the close step: got %d, want 0 (tab-2 is still named after its native view closed)", namesAfterStep)
	}
}

// contract: exposure.host-window.reads-during-surface-creation
func TestSurfaceIsNamedWhenItsNativeViewIsCreated(t *testing.T) {
	s := &Surfaces{named: map[uintptr]string{}}
	native := new(int)
	// The creation runs its step at once, as the UI thread would run it.
	view, err := s.createRegisteredSurface(func(step func()) { step() }, "tab-4leevm", func() (unsafe.Pointer, error) {
		return unsafe.Pointer(native), nil
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got := s.viewNames()[uint64(uintptr(view.handle))]; got != "tab-4leevm" {
		t.Fatalf("native view of tab-4leevm is named %q after creation", got)
	}
	// A failed creation names nothing.
	_, err = s.createRegisteredSurface(func(step func()) { step() }, "tab-6", func() (unsafe.Pointer, error) {
		return nil, errors.New("no window")
	})
	if err == nil || len(s.named) != 1 {
		t.Fatalf("failed creation: err %v, names %d", err, len(s.named))
	}
}

// contract: exposure.host-window.unregistered-surface-named
func TestUnregisteredNativeSurfaceViewFailsWithItsAddress(t *testing.T) {
	named := map[uint64]string{7: "tab-2"}
	id, err := registeredSurface(named, 7)
	if err != nil || id != "tab-2" {
		t.Fatalf("registered view: id %q, err %v; want tab-2 and no error", id, err)
	}
	_, err = registeredSurface(named, 9)
	if err == nil || err.Error() != "unregistered native surface 9" {
		t.Fatalf("unregistered view: err %v; want unregistered native surface 9", err)
	}
}
