package host

import "testing"

// contract: view.channel.ui-thread
// A theme change comes from the binding of the main page, which runs outside the UI thread, and the post of the host to the document runs
// in a step of the UI thread: the native post asserts the main thread, so a post that ran on the goroutine of the change would end the
// process.
func TestViewPostsRunOnTheUIThread(t *testing.T) {
	p := echoViewProbe(t)
	p.ready(t)
	p.s.invoke = mainThreadStep
	p.s.postThemeToViews()
	if theme := p.waitReceived(t, 2)[1]; theme["event"] != "theme" {
		t.Fatalf("the page received %v after the theme change, want the theme", theme)
	}
}
