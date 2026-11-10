package host

// The watch of the main thread (docs/spec/logging.md, stalls): a stall is the absence of events, which no event of the stalled
// thread reports, so a goroutine outside the main thread sends a heartbeat to it and compares the last heartbeat with the
// clock. No event source reports a thread that does not run, which is why this watch uses a timer while the thread handles an
// event. A run loop that waits for an event cannot be stalled, so the watch blocks without a timer through that wait. A heartbeat
// stallLate or more late is `host.stall`, the stacks of the threads go into a file of the logs folder as `host.stall.sampled`, and the next
// heartbeat is `host.stall.resumed` with the length of the stall. A `host.stall` carries watch_late_ms, the lateness of the
// watch's own wake: a stall in which the watch wakes late too is a process that the system did not schedule.

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

const (
	// stallBeat is the interval of the heartbeat and of the check.
	stallBeat = 250 * time.Millisecond
	// stallLate is the lateness of a heartbeat that is a stall.
	stallLate = time.Second
	// stallSampleRunning is the error of a stall during the sample of an earlier stall.
	stallSampleRunning = "a sample of the threads is still running"
)

// StallWatchOptions are the parts of the watch: Heartbeat sends a heartbeat that the watched thread answers and returns the time
// of the call and the time of the last answer on one clock, where the time of the answer is the time of the first heartbeat
// while none was answered; the watched thread answers without Go code (docs/spec/hosts.md, main thread of the Wails host). While
// the run loop of the watched thread waits for an event, Heartbeat sends nothing and returns the start of that wait as both times.
// AwaitAwake blocks while that run loop waits and returns while it does not.
// Sample writes the stacks of the threads of the process into a file, Folder is the logs folder and EmitHost stores an event of
// the host. Clock is the time since the watch started, which measures the lateness of the watch's own wake, and Wait waits one
// beat; nil takes the monotonic clock and time.Sleep. StopWaits is called by the stop when it begins to wait for a sample that
// runs, before it waits; a check releases the sample that it holds after this event, so a stop that returns before it finds the
// sample running. nil calls nothing.
type StallWatchOptions struct {
	Heartbeat  func() (now, answered time.Duration)
	AwaitAwake func()
	Sample     func(path string) error
	Folder     string
	EmitHost   func(Level, string, map[string]any)
	Clock      func() time.Duration
	Wait       func(time.Duration)
	StopWaits  func()
}

// StallHeartbeat is the heartbeat of the watch that the platform answers on the main thread in C.
func StallHeartbeat(system platform.Platform) func() (now, answered time.Duration) {
	return func() (time.Duration, time.Duration) {
		now, answered := system.StallHeartbeat()
		return time.Duration(now), time.Duration(answered)
	}
}

// StartStallWatch starts the watch and returns the function that stops it. The watch ends after the beat that is running. The stop
// starts no sample after it and returns when the running sample ended and stored its `host.stall.sampled`, so the process of the
// sample does not outlive the host and the stall keeps its dump.
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
	var stopped, sampling atomic.Bool
	// samples holds the running sample; ending guards stopped against the start of a sample, so the stop waits for every sample that
	// started.
	var samples sync.WaitGroup
	var ending sync.Mutex
	routine.Go("stall-watch", func() {
		options.AwaitAwake()
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
				// A stall that the watch finds after its stop is not recorded: the host ends, and the stop waits only for a sample
				// that started before it.
				ending.Lock()
				if stopped.Load() {
					ending.Unlock()
					return
				}
				stalledFrom = last
				options.EmitHost(LevelWarn, "host.stall", map[string]any{"late_ms": now - last, "watch_late_ms": watchLate.Milliseconds()})
				path := filepath.Join(options.Folder, fmt.Sprintf("stall-host-%d-%d.txt", os.Getpid(), time.Now().UnixMilli()))
				if !sampling.CompareAndSwap(false, true) {
					ending.Unlock()
					options.EmitHost(LevelWarn, "host.stall.sampled", map[string]any{"path": path, "error": stallSampleRunning})
					break
				}
				samples.Add(1)
				ending.Unlock()
				// A sample lasts for seconds on a loaded system. The watch keeps sending heartbeats meanwhile, so that time is not
				// read as lateness of the main thread.
				routine.Go("stall-sample", func() {
					defer samples.Done()
					defer sampling.Store(false)
					if err := options.Sample(path); err != nil {
						options.EmitHost(LevelWarn, "host.stall.sampled", map[string]any{"path": path, "error": err.Error()})
					} else {
						options.EmitHost(LevelWarn, "host.stall.sampled", map[string]any{"path": path})
					}
				})
			case stalledFrom >= 0 && last > stalledFrom:
				options.EmitHost(LevelInfo, "host.stall.resumed", map[string]any{"stalled_ms": last - stalledFrom})
				stalledFrom = -1
			}
			// An open stall keeps the beat: the heartbeat of this check was sent before the run loop could start to wait, so a
			// stall that ended in that wait has its end only from the next heartbeat, which the wait answers with its start. The
			// watch blocks only while no stall is open, which is also the only time the run loop of the watched thread waits.
			if stalledFrom < 0 {
				options.AwaitAwake()
			}
		}
	})
	return func() {
		ending.Lock()
		stopped.Store(true)
		// A sample starts only under this lock and before the stop, so a sample that is not running now never runs.
		running := sampling.Load()
		ending.Unlock()
		if running && options.StopWaits != nil {
			options.StopWaits()
		}
		samples.Wait()
	}
}
