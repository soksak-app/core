//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
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
			var beats atomic.Int64
			heartbeat := host.StallHeartbeat(system)
			stop := host.StartStallWatch(host.StallWatchOptions{
				Heartbeat: func() (time.Duration, time.Duration) {
					now, answered := heartbeat()
					if now != answered {
						beats.Add(1)
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
				},
			})
			defer stop()
			// A step that does not end in time for the next beat wakes the watch, and the heartbeats go on while it runs. A short
			// step does not stall.
			if err := onMain(system, func() error { spin(600 * time.Millisecond); return nil }); err != nil {
				return err
			}
			if got := beats.Load(); got == 0 {
				return fmt.Errorf("no heartbeat in a step of 600 ms on the main thread")
			}
			if got := names(); got != "" {
				return fmt.Errorf("the stall watch stored %s for a step of 600 ms", got)
			}
			// The run loop then waits: after the beat that was running, the watch sends nothing for a second.
			time.Sleep(600 * time.Millisecond)
			settled := beats.Load()
			time.Sleep(time.Second)
			if got := beats.Load() - settled; got != 0 {
				return fmt.Errorf("%d heartbeats in a second of a run loop that waits", got)
			}
			// A step that holds the main thread is a stall, and its end is recorded.
			if err := onMain(system, func() error { spin(1600 * time.Millisecond); return nil }); err != nil {
				return err
			}
			for deadline := time.Now().Add(5 * time.Second); names() != "host.stall,host.stall.sampled,host.stall.resumed"; {
				if time.Now().After(deadline) {
					return fmt.Errorf("the stall watch stored %q for a step of 1.6 s", names())
				}
				time.Sleep(10 * time.Millisecond)
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
