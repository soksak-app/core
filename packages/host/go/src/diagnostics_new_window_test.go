//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// newWindowProbe is a capture whose hold of a new window the test answers: held gives the number of the window that the hold
// took, and the end of the wait answers the wait with the error of the native library.
type newWindowProbe struct {
	captureStartProbe
	holdErr  error
	openErr  error
	held     chan int
	opened   chan CaptureTarget
	mu       sync.Mutex
	released int
}

func newNewWindowProbe() *newWindowProbe {
	return &newWindowProbe{held: make(chan int, 1), opened: make(chan CaptureTarget, 1)}
}

func (p *newWindowProbe) HoldNewWindow() error { return p.holdErr }
func (p *newWindowProbe) WaitNewWindow(registerEnd func(end func(reason string))) (int, error) {
	ended := make(chan string, 1)
	registerEnd(func(reason string) {
		select {
		case ended <- reason:
		default:
		}
	})
	select {
	case number := <-p.held:
		return number, nil
	case reason := <-ended:
		return -1, fmt.Errorf("no new window was shown before %s", reason)
	}
}
func (p *newWindowProbe) Open(target CaptureTarget) error {
	p.opened <- target
	return p.openErr
}
func (p *newWindowProbe) ReleaseNewWindow() {
	p.mu.Lock()
	p.released++
	p.mu.Unlock()
}
func (p *newWindowProbe) releases() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.released
}

// contract: diagnostics.capture-start.new-window-is-strict-boolean
func TestCaptureStartNewWindowIsAStrictBooleanWithoutDisplay(t *testing.T) {
	got, err := parseCaptureStartOptions(json.RawMessage(`{"newWindow":true}`))
	if err != nil || !got.NewWindow {
		t.Fatalf("newWindow true = %+v, %v", got, err)
	}
	got, err = parseCaptureStartOptions(json.RawMessage(`{}`))
	if err != nil || got.NewWindow {
		t.Fatalf("absent newWindow = %+v, %v", got, err)
	}
	for _, value := range []string{`null`, `"true"`, `1`} {
		_, err := parseCaptureStartOptions(json.RawMessage(`{"newWindow":` + value + `}`))
		if messageOf(err) != "newWindow must be a boolean" {
			t.Errorf("newWindow %s: error %v, want newWindow must be a boolean", value, err)
		}
	}
	_, err = parseCaptureStartOptions(json.RawMessage(`{"newWindow":true,"display":true}`))
	if messageOf(err) != "newWindow records the new window alone and cannot be combined with display" {
		t.Errorf("newWindow with display: error %v", err)
	}
}

// contract: diagnostics.capture-start.new-window-answers-once-held
func TestANewWindowRecordingAnswersOnceTheHoldIsSetAndRecordsTheHeldWindow(t *testing.T) {
	probe := newNewWindowProbe()
	var recording Recording
	directory := filepath.Join(t.TempDir(), "frames")
	if err := recording.StartNewWindow(probe, directory, false); err != nil {
		t.Fatal(err)
	}
	if recording.Running() != directory {
		t.Fatalf("the held recording owns %q, want %q", recording.Running(), directory)
	}
	select {
	case target := <-probe.opened:
		t.Fatalf("the recording opened %+v before a window was shown", target)
	default:
	}
	probe.held <- 31
	if target := <-probe.opened; target != (CaptureTarget{Window: 31}) {
		t.Fatalf("the recording opened %+v, want the held window 31 alone", target)
	}
	finished, count, _, err := recording.Finish(probe)
	if err != nil || finished != directory || count != 1 {
		t.Fatalf("finish = %q, %d, %v", finished, count, err)
	}
	if probe.releases() != 0 {
		t.Fatalf("a recording that started released its hold %d times; its stream start shows the window", probe.releases())
	}
}

// contract: diagnostics.capture-start.new-window-answers-once-held
func TestAFailedHoldStartsNoRecording(t *testing.T) {
	probe := newNewWindowProbe()
	probe.holdErr = errors.New("a new window is already held for a recording")
	var recording Recording
	err := recording.StartNewWindow(probe, filepath.Join(t.TempDir(), "frames"), false)
	if err == nil || err.Error() != "a new window is already held for a recording" {
		t.Fatalf("start error %v", err)
	}
	if recording.Running() != "" {
		t.Fatalf("a failed hold owns %q", recording.Running())
	}
}

// contract: diagnostics.capture-start.new-window-hold-ends
func TestTheStopEndsAHoldThatNoShowTook(t *testing.T) {
	probe := newNewWindowProbe()
	var recording Recording
	directory := filepath.Join(t.TempDir(), "frames")
	if err := recording.StartNewWindow(probe, directory, false); err != nil {
		t.Fatal(err)
	}
	finished, _, _, err := recording.Finish(probe)
	if finished != directory || err == nil || err.Error() != "no new window was shown before the stop of the recording" {
		t.Fatalf("finish = %q, %v", finished, err)
	}
	if recording.Running() != "" {
		t.Fatalf("the ended hold still owns %q", recording.Running())
	}
}

// contract: diagnostics.capture-start.new-window-hold-ends
func TestAFailureAfterTheHoldReleasesTheHeldWindow(t *testing.T) {
	probe := newNewWindowProbe()
	probe.openErr = errors.New("window 31 not found")
	var recording Recording
	directory := filepath.Join(t.TempDir(), "frames")
	if err := recording.StartNewWindow(probe, directory, false); err != nil {
		t.Fatal(err)
	}
	probe.held <- 31
	<-probe.opened
	finished, _, _, err := recording.Finish(probe)
	if finished != directory || err == nil || !strings.Contains(err.Error(), "window 31 not found") {
		t.Fatalf("finish = %q, %v", finished, err)
	}
	if probe.releases() != 1 {
		t.Fatalf("the failed recording released its hold %d times, want 1", probe.releases())
	}
}

// heldWindowCapturer is a platform capture whose wait for a held window ends only by its end.
type heldWindowCapturer struct {
	platform.Capturer
	waiting chan uint64
	ended   chan string
}

func (c *heldWindowCapturer) CaptureHoldNewWindow() error { return nil }
func (c *heldWindowCapturer) CaptureWaitNewWindow(token uint64) (int, error) {
	c.waiting <- token
	return -1, fmt.Errorf("no new window was shown before %s", <-c.ended)
}
func (c *heldWindowCapturer) CaptureReleaseNewWindow()               {}
func (c *heldWindowCapturer) CaptureEndWait(_ uint64, reason string) { c.ended <- reason }

// contract: diagnostics.capture-start.new-window-hold-ends
func TestTheConnectionAndTheWindowOfTheRequestEndTheWaitForAHeldWindow(t *testing.T) {
	for _, end := range []string{waitEndConnection, waitEndWindow} {
		t.Run(end, func(t *testing.T) {
			fake := &heldWindowCapturer{waiting: make(chan uint64, 1), ended: make(chan string, 1)}
			s := &Surfaces{name: "new-window-" + end}
			conn := endpointConnection(t)
			capture := platformCapture{Capturer: fake, window: s, connection: conn}
			result := make(chan error, 1)
			go func() {
				_, err := capture.WaitNewWindow(func(func(string)) {})
				result <- err
			}()
			<-fake.waiting
			if end == waitEndConnection {
				conn.close("the requester closed")
			} else {
				endNativeWaits(s, waitEndWindow)
			}
			if err := <-result; err == nil || err.Error() != "no new window was shown before "+end {
				t.Fatalf("the wait ended with %v, want its end by %s", err, end)
			}
		})
	}
}

// mainStepFramework is a framework whose step of the main thread marks the time it runs, so a test tells a call made in a step
// from a call made on the goroutine of a request.
type mainStepFramework struct {
	frameworkRecord
	inStep *atomic.Bool
}

func (f mainStepFramework) Step(task func()) {
	f.inStep.Store(true)
	defer f.inStep.Store(false)
	task()
}

// stepHoldCapturer is a platform capture that records whether its hold of a new window ran in a step of the main thread.
type stepHoldCapturer struct {
	platform.Capturer
	inStep           *atomic.Bool
	held, heldInStep bool
}

func (c *stepHoldCapturer) CaptureHoldNewWindow() error {
	c.held = true
	c.heldInStep = c.inStep.Load()
	return nil
}
func (c *stepHoldCapturer) CaptureWaitNewWindow(uint64) (int, error) {
	return -1, errors.New("no window")
}
func (c *stepHoldCapturer) CaptureReleaseNewWindow() {}

// contract: diagnostics.capture-start.new-window-answers-once-held
func TestTheHoldOfANewWindowRunsInAStepOfTheMainThread(t *testing.T) {
	// The native hold sets AppKit state and asserts the main thread; the request that starts it runs on a goroutine of the
	// endpoint, from which the native call of the main thread runs its body directly (native/darwin/src/main_thread.h).
	inStep := &atomic.Bool{}
	previous := framework
	framework = mainStepFramework{inStep: inStep}
	t.Cleanup(func() { framework = previous })
	capturer := &stepHoldCapturer{inStep: inStep}
	if err := (platformCapture{Capturer: capturer}).HoldNewWindow(); err != nil {
		t.Fatal(err)
	}
	if !capturer.held || !capturer.heldInStep {
		t.Fatalf("the hold ran %v, in a step of the main thread %v; want it in a step", capturer.held, capturer.heldInStep)
	}
}
