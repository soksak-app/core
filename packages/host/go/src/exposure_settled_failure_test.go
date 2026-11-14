//go:build diagnostics

package host

import (
	"context"
	"testing"
)

// The failure of the block ends the settled wait. The failure is the fault injection of the platform, which fails the next settled wait of
// the window in a diagnostic build.
// contract: exposure.settled-wait.presents-through-the-frontend
func TestSettledWaitEndsWithTheFailureOfThePresentation(t *testing.T) {
	s := realSettledSurfaces(t, true)
	frontend := s.window.(*realPresentedFrontend)
	var injected error
	runOnMainThread(func() { injected = system.InjectSettledFailure(frontend.window) })
	if injected != nil {
		t.Fatal(injected)
	}
	_, err := s.presented(context.Background())
	if err == nil || err.Error() != "injected native presentation failure" {
		t.Fatalf("the settled wait ended with %v, want the injected failure of the presentation", err)
	}
}
