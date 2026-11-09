package adapter

import "testing"

// A held window that closes is never released, so what waits for its release asks again at the close and hears that the window
// closed: a settled wait that a closing window holds ends, and the views that it keeps go with the window.
// contract: mygo.presentation.notice-answers
func TestAWaitForTheReleaseOfAWindowEndsWhenTheWindowCloses(t *testing.T) {
	f := &Frontend{held: true}
	asked := 0
	f.whenReleased(func() { asked++ })
	if asked != 0 {
		t.Fatalf("a held window asked again %d times before its release", asked)
	}
	f.windowClosed()
	if asked != 1 {
		t.Fatalf("the wait for the release of a closed window asked again %d times, want 1", asked)
	}
	f.whenReleased(func() { asked++ })
	if asked != 2 {
		t.Fatalf("a wait for the release of a closed window did not ask again at once")
	}
}
