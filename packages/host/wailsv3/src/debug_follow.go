// The notice of a write of the event log (docs/spec/debug.md#following): the debug view follows the event file of the host
// with the host event `debug-log-changed`, which the host announces after the writer wrote.
package host

import (
	"sync"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// CoalesceLogNotices wraps emit for the observer of the writes of the event log. The observer returns at once, so the
// writer never waits for a window; the notices that arrive while emit runs become one notice with the latest path and size.
// stop ends the goroutine that calls emit and waits until it returned.
func CoalesceLogNotices(emit func(path string, size int64)) (observe func(path string, size int64), stop func()) {
	var mu sync.Mutex
	var path string
	var size int64
	pending := false
	wake := make(chan struct{}, 1)
	quit := make(chan struct{})
	done := make(chan struct{})
	routine.Go("debug-follow", func() {
		defer close(done)
		for {
			select {
			case <-quit:
				return
			case <-wake:
			}
			mu.Lock()
			latestPath, latestSize, due := path, size, pending
			pending = false
			mu.Unlock()
			if due {
				emit(latestPath, latestSize)
			}
		}
	})
	observe = func(newPath string, newSize int64) {
		mu.Lock()
		path, size, pending = newPath, newSize, true
		mu.Unlock()
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	var once sync.Once
	stop = func() {
		once.Do(func() { close(quit) })
		<-done
	}
	return observe, stop
}
