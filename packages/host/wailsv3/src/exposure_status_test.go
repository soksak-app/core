package host

import (
	"testing"
	"time"
)

// A connection that starts watching host.window after its earlier watch ended receives the next status of the window,
// even when the status equals the status sent before the earlier watch ended. The endpoint keeps no record of sent
// values, so the value is announced to every connection that watches the status.
// contract: status.window.rewatch-notifies
func TestAWatchStartedAfterAnUnwatchReceivesTheNextWindowStatus(t *testing.T) {
	endpoint := NewEndpoint(nil)
	conn := &endpointConn{topics: map[topic]bool{}, out: make(chan []byte, 4), done: make(chan struct{})}
	endpoint.conns[conn] = true
	window := topic{"main", "host.window", ""}
	open := map[string]any{"modal": "open"}

	endpoint.subscribe(conn, window, true)
	endpoint.StatusChanged("main", "host.window", "", open)
	endpoint.subscribe(conn, window, false)
	endpoint.subscribe(conn, window, true)
	endpoint.StatusChanged("main", "host.window", "", open)

	for n := 1; n <= 2; n++ {
		select {
		case <-conn.out:
		case <-time.After(5 * time.Second):
			t.Fatalf("the status announced by change %d did not reach the connection that watches the window", n)
		}
	}
}
