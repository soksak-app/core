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

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

const (
	// stallBeat is the interval of the heartbeat and of the check.
	stallBeat = 250 * time.Millisecond
	// stallLate is the lateness of a heartbeat that is a stall.
	stallLate = time.Second
)

// StallWatchOptions are the parts of the watch: Heartbeat sends a heartbeat that the watched thread answers and returns the time
// of the call and the time of the last answer on one clock, where the time of the answer is the time of the first heartbeat
// while none was answered; the watched thread answers without Go code (docs/spec/hosts.md, main thread of the Wails host).
// Sample writes the stacks of the threads of the process into a file, Folder is the logs folder and EmitHost stores an event of
// the host. Clock is the time since the watch started, which measures the lateness of the watch's own wake, and Wait waits one
// beat; nil takes the monotonic clock and time.Sleep.
type StallWatchOptions struct {
	Heartbeat func() (now, answered time.Duration)
	Sample    func(path string) error
	Folder    string
	EmitHost  func(Level, string, map[string]any)
	Clock     func() time.Duration
	Wait      func(time.Duration)
}

// StallHeartbeat is the heartbeat of the watch that the platform answers on the main thread in C.
func StallHeartbeat(system platform.Platform) func() (now, answered time.Duration) {
	return func() (time.Duration, time.Duration) {
		now, answered := system.StallHeartbeat()
		return time.Duration(now), time.Duration(answered)
	}
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
	var stopped atomic.Bool
	routine.Go("stall-watch", func() {
		// The first heartbeat is the reference of the answers until the watched thread answers one.
		options.Heartbeat()
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
			sent, answered := options.Heartbeat()
			now, last := sent.Milliseconds(), answered.Milliseconds()
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
