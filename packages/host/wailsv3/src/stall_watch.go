package host

// The watch of the main thread (docs/spec/logging.md, stalls): a stall is the absence of events, which no event of the stalled
// thread reports, so a goroutine outside the main thread sends a heartbeat to it and compares the last heartbeat with the
// clock. No event source reports a thread that does not run, which is why this watch uses a timer. A heartbeat stallLate or
// more late is `host.stall`, the stacks of the threads go into a file of the logs folder as `host.stall.sampled`, and the next
// heartbeat is `host.stall.resumed` with the length of the stall. A `host.stall` carries watch_late_ms, the lateness of the
// watch's own wake: a stall in which the watch wakes late too is a process that the system did not schedule.

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
// threads of the process into a file, Folder is the logs folder and EmitHost stores an event of the host. Clock is the time
// since the watch started and Wait waits one beat; nil takes the monotonic clock and time.Sleep.
type StallWatchOptions struct {
	OnMain   func(func())
	Sample   func(path string) error
	Folder   string
	EmitHost func(Level, string, map[string]any)
	Clock    func() time.Duration
	Wait     func(time.Duration)
}

// StartStallWatch starts the watch and returns the function that stops it. The watch ends after the beat that is running.
func StartStallWatch(options StallWatchOptions) func() {
	clock := options.Clock
	if clock == nil {
		start := time.Now()
		clock = func() time.Duration { return time.Since(start) }
	}
	wait := options.Wait
	if wait == nil {
		wait = time.Sleep
	}
	var beat atomic.Int64
	var stopped atomic.Bool
	routine.Go("stall-watch", func() {
		var stalledFrom int64 = -1
		for !stopped.Load() {
			before := clock()
			wait(stallBeat)
			// The lateness of this beat: the time that the watch slept beyond stallBeat. When the whole process is not scheduled, the
			// watch wakes late as well as the main thread; when the main thread is blocked, the watch wakes on time.
			watchLate := clock() - before - stallBeat
			if watchLate < 0 {
				watchLate = 0
			}
			options.OnMain(func() { beat.Store(clock().Milliseconds()) })
			now, last := clock().Milliseconds(), beat.Load()
			switch {
			case stalledFrom < 0 && now-last >= stallLate.Milliseconds():
				stalledFrom = last
				options.EmitHost(LevelWarn, "host.stall", map[string]any{"late_ms": now - last, "watch_late_ms": watchLate.Milliseconds()})
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
	return func() { stopped.Store(true) }
}
