package host

import "testing"

// The close of a window ends every status watch of the window, with and without a surface, and keeps the watches of other
// windows.
// contract: endpoint.status.ended-ends-a-watch
func TestTheCloseOfAWindowEndsEveryWatchOfIt(t *testing.T) {
	e := NewEndpoint(nil)
	watcher := &endpointConn{topics: map[topic]bool{}, out: make(chan endpointFrame, 8), done: make(chan struct{})}
	e.conns[watcher] = true
	page, surface, other := topic{"main", "fixture.value", ""}, topic{"main", "fixture.value", "tab"}, topic{"second", "fixture.value", ""}
	for _, watched := range []topic{page, surface, other} {
		e.subscribe(watcher, watched, true)
	}
	e.ProducerEnded("main", "", "window-closed")
	settled(e, page)
	settled(e, surface)
	ended := map[string]bool{}
	for n := 0; n < 2; n++ {
		got := endedFrame(t, watcher, "the close of the window")
		params, _ := got["params"].(map[string]any)
		if got["method"] != "status.ended" || params["window"] != "main" || params["reason"] != "window-closed" {
			t.Fatalf("frame %v, want status.ended of window main with reason window-closed", got)
		}
		named, _ := params["surface"].(string)
		ended[named] = true
	}
	if !ended[""] || !ended["tab"] {
		t.Fatalf("ended watches %v, want the page watch and the watch of surface tab", ended)
	}
	e.mu.Lock()
	kept := watcher.topics[other] && !watcher.topics[page] && !watcher.topics[surface]
	e.mu.Unlock()
	if !kept {
		t.Fatal("the close of window main changed the watch of window second or kept a watch of main")
	}
}
