package host

import (
	"encoding/json"
	"reflect"
	"testing"
)

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

// contract: view.theme.deferred-is-recorded
// A theme change that finds a view without a ready document is not posted to it, because its ready message receives the current
// theme, and the host records the skip with the surface and that reason.
func TestAThemeChangeBeforeTheViewIsReadyIsRecordedAndTheReadyMessageReceivesIt(t *testing.T) {
	isolateTraceRecords(t)
	p := echoViewProbe(t)
	p.s.postThemeToViews()
	var deferred []map[string]any
	records.Lock()
	for _, record := range records.buffer {
		if record.event != "host.view.theme.deferred" {
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal(record.fields, &fields); err != nil {
			records.Unlock()
			t.Fatal(err)
		}
		deferred = append(deferred, fields)
	}
	records.Unlock()
	want := []map[string]any{{"surface": "probe-surface", "reason": themeDeferredReason}}
	if !reflect.DeepEqual(deferred, want) {
		t.Fatalf("host.view.theme.deferred records %v, want %v", deferred, want)
	}
	// The ready message then receives the theme.
	p.ready(t)
}
