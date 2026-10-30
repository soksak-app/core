//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// An init function runs on the main thread, and the lock keeps the main goroutine there, so TestMain runs the application on
// the main thread as the host does.
func init() { runtime.LockOSThread() }

// TestMain runs the application of the framework on the main thread, without a window and with the prohibited activation
// policy, so it takes no activation and shows no Dock icon. The tests start when the application finished launching, and the
// process ends with their status.
func TestMain(m *testing.M) {
	if err := CaptureMainThread(); err != nil {
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
			beats := make(chan struct{}, 64)
			heartbeat := host.StallHeartbeat(system)
			stop := host.StartStallWatch(host.StallWatchOptions{
				Heartbeat: func() (time.Duration, time.Duration) {
					now, answered := heartbeat()
					beats <- struct{}{}
					return now, answered
				},
				Sample: func(string) error { return nil },
				Folder: t.TempDir(),
				EmitHost: func(_ host.Level, name string, _ map[string]any) {
					emittedLock.Lock()
					defer emittedLock.Unlock()
					emitted = append(emitted, name)
				},
			})
			// Eight heartbeats of 250 ms each.
			for range 8 {
				<-beats
			}
			stop()
			emittedLock.Lock()
			defer emittedLock.Unlock()
			if len(emitted) > 0 {
				return fmt.Errorf("the stall watch stored %v", emitted)
			}
			return nil
		}},
	}
	if err := StartSampler(); err != nil {
		t.Fatal(err)
	}
	var driveErrors []string
	for phase, entry := range entries {
		SetPhase(phase)
		if err := entry.drive(); err != nil {
			driveErrors = append(driveErrors, fmt.Sprintf("%s: %v", entry.name, err))
		}
	}
	SetPhase(-1)
	counts, err := StopSampler()
	if err != nil {
		t.Fatal(err)
	}
	if len(driveErrors) > 0 {
		t.Fatalf("driving the entry points failed: %s", strings.Join(driveErrors, "; "))
	}
	low, high := StackBounds()
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
