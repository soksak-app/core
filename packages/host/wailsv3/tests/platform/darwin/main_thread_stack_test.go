//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	sampler "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
	// The framework adapter installs the main-thread functions of the framework, which the steps below run through.
	_ "github.com/soksak-app/core/packages/host/wailsv3/src/platform/darwin"
)

// An init function runs on the main thread, and the lock keeps the main goroutine there, so TestMain runs the application on
// the main thread as the host does.
func init() { runtime.LockOSThread() }

// TestMain blocks the asynchronous signals on the main thread and runs the application of the framework there, as the host
// does, without a window and with the prohibited activation policy, so it takes no activation and shows no Dock icon. The tests
// start when the application finished launching, and the process ends with their status.
func TestMain(m *testing.M) {
	if err := sampler.CaptureMainThread(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// The host blocks the asynchronous signals on the main thread before the application runs.
	system, err := platform.Current()
	if err == nil {
		err = system.BlockAsyncSignals()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	app := application.New(application.Options{
		Name: "soksak-main-thread-test",
		Mac:  application.MacOptions{ActivationPolicy: application.ActivationPolicyProhibited, DisableActivationOnLaunch: true},
	})
	app.Event.OnApplicationEvent(events.Mac.ApplicationDidFinishLaunching, func(*application.ApplicationEvent) {
		go func() { os.Exit(m.Run()) }()
	})
	if err := app.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "the application did not run:", err)
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "the application ended before the tests ended")
	os.Exit(1)
}

// spin runs Go code for the duration, as the work that a main-thread step of the host runs.
func spin(duration time.Duration) {
	for start := time.Now(); time.Since(start) < duration; {
	}
}

// onMain runs work as one main-thread step through EnqueueUI and returns its error, as the host runs the calls that need the
// main thread.
func onMain(system platform.Platform, work func() error) error {
	result := make(chan error, 1)
	if err := system.EnqueueUI(func() { result <- work() }); err != nil {
		return err
	}
	return <-result
}

// stallBeat is one heartbeat of the stall watch: the time of the call and its lateness on the clock of the heartbeat, where a
// heartbeat that read a wait of the run loop has the start of that wait as its time and no lateness, and the clock time at which it
// returned.
type stallBeat struct {
	now, late time.Duration
	at        time.Time
}

// stallBeats states the heartbeats, each time after from: a heartbeat that read a wait with the start of that wait, and any other
// with the time of its call and its lateness.
func stallBeats(beats []stallBeat, from time.Duration) string {
	if len(beats) == 0 {
		return "none"
	}
	var stated []string
	for _, beat := range beats {
		if beat.late == 0 {
			stated = append(stated, fmt.Sprintf("read the wait from %v", (beat.now-from).Round(time.Microsecond)))
		} else {
			stated = append(stated, fmt.Sprintf("sent at %v, %v late", (beat.now-from).Round(time.Microsecond), beat.late))
		}
	}
	return strings.Join(stated, ", ")
}

// runLoopTurns states the turns of the main run loop from the time on, each time after it: each wake with its mode, the start of
// the wait that it ended and the next timer of that wait, then the activities of the turn up to its next wait.
func runLoopTurns(activities []sampler.RunLoopActivity, from time.Duration) string {
	var turns, turn []string
	var wait *sampler.RunLoopActivity
	end := func() {
		if len(turn) > 0 {
			turns = append(turns, strings.Join(turn, " "))
			turn = nil
		}
	}
	after := func(at time.Duration) time.Duration { return (at - from).Round(time.Microsecond) }
	for index := range activities {
		activity := &activities[index]
		switch {
		case activity.Activity == "wait":
			if activity.At >= from {
				turn = append(turn, "wait")
				end()
			}
			wait = activity
		case activity.At < from:
		case activity.Activity == "wake":
			end()
			mode := "the default mode"
			if !activity.DefaultMode {
				mode = "another mode"
			}
			ended, timer := "a wait before the recorder", "no timer"
			if wait != nil {
				ended = fmt.Sprintf("the wait from %v", after(wait.At))
				if wait.HasTimer {
					timer = fmt.Sprintf("a timer due at %v", after(wait.At+wait.TimerIn))
				}
			}
			turn = append(turn, fmt.Sprintf("wake at %v in %s, ending %s with %s:", after(activity.At), mode, ended, timer))
		default:
			turn = append(turn, activity.Activity)
		}
	}
	end()
	if len(turns) == 0 {
		return "no turn"
	}
	return strings.Join(turns, "; ")
}

// The main thread runs no code on a stack other than its own while the host runs its main-thread steps
// (docs/spec/hosts.md, main thread of the Wails host): the collector of a JavaScriptCore VM copies the stack of the main thread from
// its stack pointer to the origin of its stack, and a stack pointer outside that stack ends the process.
// contract: host.main-thread.runs-no-code-outside-own-stack
func TestTheMainThreadRunsNoCodeOutsideItsOwnStack(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	const rounds = 100
	const work = 2 * time.Millisecond
	entries := []struct {
		name  string
		drive func() error
	}{
		{"EnqueueUI", func() error {
			for range rounds {
				done := make(chan struct{})
				if err := system.EnqueueUI(func() { spin(work); close(done) }); err != nil {
					return err
				}
				<-done
			}
			return nil
		}},
		{"application.InvokeSync", func() error {
			for range rounds {
				application.InvokeSync(func() { spin(work) })
			}
			return nil
		}},
		// The Dock menu item runs the exported callback of the Dock menu from the action of the menu.
		{"Dock menu callback", func() error {
			opened := make(chan struct{})
			if err := onMain(system, func() error {
				return system.InstallDock(func() { spin(work); opened <- struct{}{} })
			}); err != nil {
				return err
			}
			for range rounds {
				if err := onMain(system, func() error { return system.DockSelect("새 창") }); err != nil {
					return err
				}
				<-opened
			}
			return nil
		}},
		// An injected level runs the exported callback of the memory pressure source inside the call that the step makes.
		{"memory pressure callback", func() error {
			reported := make(chan string, 1)
			if err := onMain(system, func() error {
				return system.OnMemoryPressure(func(level string, _ uint64) { spin(work); reported <- level })
			}); err != nil {
				return err
			}
			levels := [2]string{"warn", "normal"}
			for round := range rounds {
				level := levels[round%2]
				if err := onMain(system, func() error { return system.InjectMemoryPressure(level) }); err != nil {
					return err
				}
				if got := <-reported; got != level {
					return fmt.Errorf("the source reported %s for the injected level %s", got, level)
				}
			}
			return nil
		}},
		{"stall heartbeat", func() error {
			var emittedLock sync.Mutex
			var emitted []string
			names := func() string {
				emittedLock.Lock()
				defer emittedLock.Unlock()
				return strings.Join(emitted, ",")
			}
			// Each heartbeat of the watch, in its order. A failure lists the heartbeats that it judged.
			var beatsLock sync.Mutex
			var beats []stallBeat
			// waited receives the index of the first heartbeat that reads a wait of the run loop once the test armed it with
			// waitArmed; both are held by beatsLock.
			waited := make(chan int, 1)
			waitArmed := false
			heartbeat := host.StallHeartbeat(system)
			resumed := make(chan struct{}, 1)
			stop := host.StartStallWatch(host.StallWatchOptions{
				Heartbeat: func() (time.Duration, time.Duration) {
					now, answered := heartbeat()
					beatsLock.Lock()
					defer beatsLock.Unlock()
					beats = append(beats, stallBeat{now, now - answered, time.Now()})
					if now == answered && waitArmed {
						waitArmed = false
						waited <- len(beats) - 1
					}
					return now, answered
				},
				AwaitAwake: system.StallAwaitAwake,
				Sample:     func(string) error { return nil },
				Folder:     t.TempDir(),
				EmitHost: func(_ host.Level, name string, _ map[string]any) {
					emittedLock.Lock()
					defer emittedLock.Unlock()
					emitted = append(emitted, name)
					if name == "host.stall.resumed" {
						select {
						case resumed <- struct{}{}:
						default:
						}
					}
				},
			})
			defer stop()
			// beatsFrom returns the heartbeats from the index on.
			beatsFrom := func(index int) []stallBeat {
				beatsLock.Lock()
				defer beatsLock.Unlock()
				return append([]stallBeat(nil), beats[index:]...)
			}
			// The recorder keeps each activity of the main run loop from the step to the end of the second below, so a run states
			// what woke the run loop.
			sampler.StartRunLoopRecorder()
			// A step that does not end in time for the next beat wakes the watch, and the heartbeats go on while it runs. A short
			// step does not stall.
			if err := onMain(system, func() error { spin(600 * time.Millisecond); return nil }); err != nil {
				sampler.StopRunLoopRecorder()
				return err
			}
			stepEnd := time.Now()
			if len(beatsFrom(0)) == 0 {
				sampler.StopRunLoopRecorder()
				return fmt.Errorf("no heartbeat in a step of 600 ms on the main thread")
			}
			if got := names(); got != "" {
				sampler.StopRunLoopRecorder()
				return fmt.Errorf("the stall watch stored %s for a step of 600 ms", got)
			}
			// The run loop then waits, and the watch reads the wait with its next heartbeat. The last heartbeat may already have
			// read it.
			beatsLock.Lock()
			if last := beats[len(beats)-1]; last.late == 0 {
				waited <- len(beats) - 1
			} else {
				waitArmed = true
			}
			beatsLock.Unlock()
			var settled int
			select {
			case settled = <-waited:
			case <-time.After(10 * time.Second):
				sampler.StopRunLoopRecorder()
				return fmt.Errorf("no heartbeat read a wait of the run loop within 10 s of the step; heartbeats %s", stallBeats(beatsFrom(0), 0))
			}
			// The heartbeats from the end of the step to the one that read the wait, each with its clock time after the end and its
			// lateness, show how long the run loop took to wait after the step.
			var settling []string
			for _, b := range beatsFrom(0)[:settled+1] {
				if b.at.After(stepEnd) {
					settling = append(settling, fmt.Sprintf("+%v late %v", b.at.Sub(stepEnd).Round(time.Millisecond), b.late))
				}
			}
			t.Logf("stall heartbeat: after the step, %s", strings.Join(settling, ", "))
			// Through a wait the watch blocks and sends nothing (docs/spec/logging.md, stalls): a heartbeat that reads a wait
			// returns the start of that wait, and the watch sends its next heartbeat only after the run loop woke from it. For a
			// second the heartbeat after one that read a wait therefore reads a later wait or a run loop that handles an event; a
			// heartbeat that reads the same wait again was sent through that wait. Whatever wakes the run loop is outside the
			// watch, and the recorder states each wake.
			time.Sleep(time.Second)
			activities, recorded := sampler.StopRunLoopRecorder()
			if recorded != nil {
				return recorded
			}
			judged := beatsFrom(settled)
			turns := runLoopTurns(activities, judged[0].now)
			heartbeats := stallBeats(judged[1:], judged[0].now)
			t.Logf("stall heartbeat: from the wait that a heartbeat read, %d heartbeats in a second: %s; the run loop: %s",
				len(judged)-1, heartbeats, turns)
			for index := 1; index < len(judged); index++ {
				before, after := judged[index-1], judged[index]
				if before.late == 0 && after.late == 0 && after.now == before.now {
					return fmt.Errorf("heartbeat %d of the second read the wait that the heartbeat before it read, so the watch sent it through that wait; from that wait, heartbeats %s; the run loop: %s",
						index, heartbeats, turns)
				}
			}
			if got := names(); got != "" {
				return fmt.Errorf("the stall watch stored %s in the second after the heartbeat that read the wait; the run loop: %s", got, turns)
			}
			// A step that holds the main thread is a stall, and its end is recorded.
			if err := onMain(system, func() error { spin(1600 * time.Millisecond); return nil }); err != nil {
				return err
			}
			select {
			case <-resumed:
			case <-time.After(5 * time.Second):
			}
			if got := names(); got != "host.stall,host.stall.sampled,host.stall.resumed" {
				return fmt.Errorf("the stall watch stored %q for a step of 1.6 s", got)
			}
			return nil
		}},
		// The kernel delivers a signal that is sent to the process to a thread that does not block it, the main thread among
		// them, and the Go signal handler runs on the signal stack of its thread, which the Go heap holds. The main thread
		// waits in its run loop while a goroutine sends SIGCHLD and SIGURG to the process.
		{"asynchronous signals", func() error {
			pid := os.Getpid()
			for start := time.Now(); time.Since(start) < time.Second; {
				for _, signal := range []syscall.Signal{syscall.SIGCHLD, syscall.SIGURG} {
					if err := syscall.Kill(pid, signal); err != nil {
						return fmt.Errorf("sending %v: %w", signal, err)
					}
				}
				time.Sleep(50 * time.Microsecond)
			}
			return nil
		}},
	}
	if err := sampler.StartSampler(); err != nil {
		t.Fatal(err)
	}
	var driveErrors []string
	for phase, entry := range entries {
		sampler.SetPhase(phase)
		if err := entry.drive(); err != nil {
			driveErrors = append(driveErrors, fmt.Sprintf("%s: %v", entry.name, err))
		}
	}
	sampler.SetPhase(-1)
	counts, err := sampler.StopSampler()
	if err != nil {
		t.Fatal(err)
	}
	if len(driveErrors) > 0 {
		t.Fatalf("driving the entry points failed: %s", strings.Join(driveErrors, "; "))
	}
	low, high := sampler.StackBounds()
	var report []string
	outside := false
	for phase, entry := range entries {
		count := counts[phase]
		if count.Samples == 0 {
			t.Fatalf("%s: the sampler took no sample", entry.name)
		}
		line := fmt.Sprintf("%s: %d of %d samples outside", entry.name, count.Outside, count.Samples)
		if count.Outside > 0 {
			outside = true
			line += fmt.Sprintf(" (first stack pointer %#x)", count.FirstOutside)
		}
		report = append(report, line)
	}
	if outside {
		t.Fatalf("the main thread ran outside its stack [%#x, %#x]: %s", low, high, strings.Join(report, "; "))
	}
	t.Logf("stack [%#x, %#x]: %s", low, high, strings.Join(report, "; "))
}
