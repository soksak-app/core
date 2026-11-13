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
// AwaitAwake blocks while that run loop waits and returns while it does not. Schedule reads the scheduling priority of the process and
// the CPU time of its threads, which the stall and its end carry; a read that fails is the error record `stall watch`.
// Sample writes the stacks of the threads of the process into a file, Folder is the logs folder and EmitHost stores an event of
// the host. Clock is the time since the watch started, which measures the lateness of the watch's own wake, and Wait waits one
// beat; nil takes the monotonic clock and time.Sleep. StopWaits is called by the stop when it begins to wait for a sample that
// runs, before it waits; a check releases the sample that it holds after this event, so a stop that returns before it finds the
// sample running. nil calls nothing.
type StallWatchOptions struct {
	Heartbeat  func() (now, answered time.Duration)
	AwaitAwake func()
	Schedule   func() (priority int32, cpuNanos uint64, err error)
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

// stallState is the state of the watch between two beats.
type stallState struct {
	// stalledFrom is the last answer of the open stall in milliseconds, or -1 when no stall is open.
	stalledFrom int64
	// cpu is the CPU time of the process when the open stall was recorded, when cpuKnown is true.
	cpu      uint64
	cpuKnown bool
}

// stallSchedule is the reading of the process schedule on a beat that starts or ends a stall; err is the failure of the read.
type stallSchedule struct {
	priority int32
	cpu      uint64
	err      error
}

// stallReading is what the watch reads on one beat: the time of the heartbeat and the time of its last answer in milliseconds, the
// lateness of the wake of the watch beyond stallBeat, and the schedule, which only a beat that starts or ends a stall reads.
type stallReading struct {
	now, last int64
	watchLate time.Duration
	schedule  stallSchedule
}

// stallOutcome is the decision of the watch on one beat. next is the state after the beat. record is the event of the host that
// the beat stores with fields at level, and it is empty for a beat that stores none. starts reports that the beat starts a stall,
// which starts a sample. scheduleErr is the failure of the schedule read that the beat reports.
type stallOutcome struct {
	next        stallState
	starts      bool
	record      string
	level       Level
	fields      map[string]any
	scheduleErr error
}

// stallStarts reports whether a beat finds a stall: no stall is open and the last answer is stallLate or more before the heartbeat.
func stallStarts(state stallState, now, last int64) bool {
	return state.stalledFrom < 0 && now-last >= stallLate.Milliseconds()
}

// stallEnds reports whether a beat finds the end of the open stall: the thread answered after the stall was recorded.
func stallEnds(state stallState, last int64) bool {
	return state.stalledFrom >= 0 && last > state.stalledFrom
}

// stallChanges reports whether a beat starts or ends a stall, which are the only beats that read the schedule.
func stallChanges(state stallState, now, last int64) bool {
	return stallStarts(state, now, last) || stallEnds(state, last)
}

// stallStep is the decision of the watch on one beat from its state and its readings. A beat that neither starts nor ends a stall
// stores nothing and keeps the state. The schedule of the reading is read only when stallChanges reports the beat.
func stallStep(state stallState, reading stallReading) stallOutcome {
	switch {
	case stallStarts(state, reading.now, reading.last):
		fields := map[string]any{"late_ms": reading.now - reading.last, "watch_late_ms": reading.watchLate.Milliseconds()}
		outcome := stallOutcome{next: stallState{stalledFrom: reading.last}, starts: true, record: "host.stall", level: LevelWarn, fields: fields}
		if reading.schedule.err != nil {
			outcome.scheduleErr = reading.schedule.err
		} else {
			fields["priority"] = int64(reading.schedule.priority)
			outcome.next.cpu, outcome.next.cpuKnown = reading.schedule.cpu, true
		}
		return outcome
	case stallEnds(state, reading.last):
		fields := map[string]any{"stalled_ms": reading.last - state.stalledFrom}
		outcome := stallOutcome{
			next:   stallState{stalledFrom: -1, cpu: state.cpu, cpuKnown: state.cpuKnown},
			record: "host.stall.resumed", level: LevelInfo, fields: fields,
		}
		if reading.schedule.err != nil {
			outcome.scheduleErr = reading.schedule.err
		} else if state.cpuKnown {
			fields["cpu_ms"] = int64(time.Duration(reading.schedule.cpu - state.cpu).Milliseconds())
		}
		return outcome
	}
	return stallOutcome{next: state}
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
		state := stallState{stalledFrom: -1}
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
			reading := stallReading{now: sent.Milliseconds(), last: answered.Milliseconds(), watchLate: watchLate}
			if stallChanges(state, reading.now, reading.last) {
				priority, cpu, err := options.Schedule()
				reading.schedule = stallSchedule{priority: priority, cpu: cpu, err: err}
			}
			outcome := stallStep(state, reading)
			if outcome.starts {
				// A stall that the watch finds after its stop is not recorded: the host ends, and the stop waits only for a sample
				// that started before it.
				ending.Lock()
				if stopped.Load() {
					ending.Unlock()
					return
				}
			}
			state = outcome.next
			if outcome.scheduleErr != nil {
				LogError("stall watch", outcome.scheduleErr.Error())
			}
			if outcome.record != "" {
				options.EmitHost(outcome.level, outcome.record, outcome.fields)
			}
			if outcome.starts {
				path := filepath.Join(options.Folder, fmt.Sprintf("stall-host-%d-%d.txt", os.Getpid(), time.Now().UnixMilli()))
				if !sampling.CompareAndSwap(false, true) {
					ending.Unlock()
					options.EmitHost(LevelWarn, "host.stall.sampled", map[string]any{"path": path, "error": stallSampleRunning})
				} else {
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
				}
			}
			// An open stall keeps the beat: the heartbeat of this check was sent before the run loop could start to wait, so a
			// stall that ended in that wait has its end only from the next heartbeat, which the wait answers with its start. The
			// watch blocks only while no stall is open, which is also the only time the run loop of the watched thread waits.
			if state.stalledFrom < 0 {
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
