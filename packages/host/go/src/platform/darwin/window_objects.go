//go:build darwin && diagnostics

package darwin

// Counts the live library objects attached to windows and web views. The implementation is window_objects.m of native/darwin. It is included only in
// diagnostic builds.

import (
	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
)

func goHost_window_objects_counted(handle uintptr, compositions, hosts, registrations int64, reached bool) {
	// handle is the value that WindowObjectsWhen created, and the library calls done once.
	h := handles.Handle(handle)
	done := h.Value().(func(platform.WindowObjects, bool))
	h.Delete()
	done(platform.WindowObjects{
		WindowCompositions: int64(compositions),
		SurfaceHosts:       int64(hosts),
		InputRegistrations: int64(registrations),
	}, bool(reached))
}

// WindowObjectsWhen gives done the count at the time when the count becomes equal to expected after the application handled one event, or when seconds pass.
// Call it in a main-thread step.
func (implementation) WindowObjectsWhen(expected *platform.WindowObjects, seconds float64,
	done func(platform.WindowObjects, bool)) {
	var wanted *abi.SpWindowObjects
	if expected != nil {
		wanted = &abi.SpWindowObjects{
			WindowCompositions: int64(expected.WindowCompositions),
			SurfaceHosts:       int64(expected.SurfaceHosts),
			InputRegistrations: int64(expected.InputRegistrations),
		}
	}
	diagnosticNative.CountWhen(wanted, float64(seconds), uintptr(handles.NewHandle(done)))
}
