package host

import "testing"

// contract: view.channel.ui-thread
func TestViewPostsRunOnTheUIThread(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	ready := `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1","time_origin":1234.5}}`
	if err := s.viewMessage("probe-surface", ready); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	// A theme change comes from the binding of the main page, which runs outside the UI thread.
	s.postThemeToViews()
	if len(fake.postedOnUI) != 2 {
		t.Fatalf("posts %d, want the theme after ready and the theme change", len(fake.postedOnUI))
	}
	for i, onUI := range fake.postedOnUI {
		if !onUI {
			t.Fatalf("post %d reached the native document outside a UI-thread task", i)
		}
	}
}
