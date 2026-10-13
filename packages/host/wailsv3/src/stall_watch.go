package host

// The watch of the main thread (docs/spec/logging.md, stalls): a stall is the absence of events, which no event of the stalled
// thread reports, so a goroutine outside the main thread sends a heartbeat to it and compares the last heartbeat with the
// clock. No event source reports a thread that does not run, which is why this watch uses a timer. A heartbeat stallLate or
// more late is `host.stall`, the stacks of the threads go into a file of the logs folder as `host.stall.sampled`, and the next
// heartbeat is `host.stall.resumed` with the length of the stall.

import (
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

const (
	// stallBeat is the interval of the heartbeat and of the check.
	stallBeat = 250 * time.Millisecond
	// stallLate is the lateness of a heartbeat that is a stall.
	stallLate = time.Second
)

// StallWatchOptions are the parts of the watch: OnMain runs a function on the watched thread, Sample writes the stacks of the
// threads of the process into a file, Folder is the logs folder and EmitHost stores an event of the host.
type StallWatchOptions struct {
	OnMain   func(func())
	Sample   func(path string) error
	Folder   string
	EmitHost func(Level, string, map[string]any)
}

// StartStallWatch starts the watch and returns the function that stops it.
func StartStallWatch(options StallWatchOptions) func() {
	start := time.Now()
	var beat atomic.Int64
	done := make(chan struct{})
	routine.Go("stall-watch", func() {
		ticker := time.NewTicker(stallBeat)
		defer ticker.Stop()
		var stalledFrom int64 = -1
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
			}
			options.OnMain(func() { beat.Store(time.Since(start).Milliseconds()) })
			now, last := time.Since(start).Milliseconds(), beat.Load()
			switch {
			case stalledFrom < 0 && now-last >= stallLate.Milliseconds():
				stalledFrom = last
				options.EmitHost(LevelWarn, "host.stall", map[string]any{"late_ms": now - last})
				path := filepath.Join(options.Folder, fmt.Sprintf("stall-host-%d-%d.txt", os.Getpid(), time.Now().UnixMilli()))
				if err := options.Sample(path); err != nil {
					options.EmitHost(LevelWarn, "host.stall.sampled", map[string]any{"path": path, "error": err.Error()})
				} else {
					options.EmitHost(LevelWarn, "host.stall.sampled", map[string]any{"path": path})
				}
			case stalledFrom >= 0 && last > stalledFrom:
				options.EmitHost(LevelInfo, "host.stall.resumed", map[string]any{"stalled_ms": last - stalledFrom})
				stalledFrom = -1
			}
		}
	})
	return func() { close(done) }
}
