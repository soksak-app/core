//go:build darwin

// Package darwin samples the stack pointer of the main thread for the tests of the Go framework adapters (docs/spec/hosts.md, main
// thread of the Wails host). The sampler reads the stack pointer of the main thread as the collector of a JavaScriptCore VM reads it when it scans a
// thread (captureStack in MachineStackMarker.cpp): it suspends the thread with thread_suspend, reads its registers with
// thread_get_state and resumes it. A sample whose stack pointer lies outside the stack of the main thread is a moment in which
// the main thread runs on a stack that the Go heap holds. The package also records the activities of the main run loop with the
// counts of the stall watch of the native library, and runs the stall check that the tests of both adapters make.
package darwin

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	testabi "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/abi"
)

// Phases is the number of phases that the sampler counts apart.
const Phases = int(testabi.SP_HOST_TEST_SAMPLER_PHASES)

// PhaseCount is what the sampler counted while one phase was set: the samples, the samples whose stack pointer was outside the
// stack of the main thread, and the stack pointer of the first such sample.
type PhaseCount struct {
	Samples      uint64
	Outside      uint64
	FirstOutside uintptr
}

// CaptureMainThread records the calling thread as the thread that the sampler samples; it fails on a thread other than the main
// thread.
func CaptureMainThread() error {
	functions, err := installedNativeFunctions()
	if err != nil {
		return err
	}
	if functions.SpHostTestSamplerCaptureMain() == 0 {
		return fmt.Errorf("sampler: the calling thread is not the main thread")
	}
	return nil
}

// StartSampler starts the thread that samples the main thread. It samples only while a phase is set.
func StartSampler() error {
	functions, err := installedNativeFunctions()
	if err != nil {
		return err
	}
	if result := functions.SpHostTestSamplerStart(); result != 0 {
		return fmt.Errorf("sampler: pthread_create returned %d", int(result))
	}
	return nil
}

// SetPhase sets the phase that the next samples count for; -1 stops the sampling.
func SetPhase(phase int) {
	functions := requireNativeFunctions()
	if phase >= Phases {
		panic(fmt.Sprintf("sampler: phase %d is not below %d", phase, Phases))
	}
	functions.SpHostTestSamplerSetPhase(int32(phase))
}

// StopSampler ends the sampling thread and returns the count of each phase. A failed suspend, read or resume is an error, with the
// number of failures and the last kernel result.
func StopSampler() ([]PhaseCount, error) {
	functions, err := installedNativeFunctions()
	if err != nil {
		return nil, err
	}
	if result := functions.SpHostTestSamplerStop(); result != 0 {
		return nil, fmt.Errorf("sampler: pthread_join returned %d", int(result))
	}
	counts := make([]PhaseCount, Phases)
	for phase := range counts {
		counts[phase] = PhaseCount{
			Samples:      uint64(functions.SpHostTestSamplerPhaseSamples(int32(phase))),
			Outside:      uint64(functions.SpHostTestSamplerPhaseOutside(int32(phase))),
			FirstOutside: uintptr(functions.SpHostTestSamplerPhaseFirstOutside(int32(phase))),
		}
	}
	if failures := uint64(functions.SpHostTestSamplerFailureCount()); failures > 0 {
		return counts, fmt.Errorf("sampler: %d thread calls failed, the last with kernel result %d", failures, int(functions.SpHostTestSamplerFailureLast()))
	}
	return counts, nil
}

// RunLoopActivity is one activity of the main run loop that the recorder kept: its time on the clock of the heartbeat of the stall
// watch, its name, whether the run loop ran in its default mode, at the start of a wait the time until the next timer of the mode
// (TimerIn, when HasTimer), and the counts of the stall watch at the activity: its sends into a wait and the blocks of its
// heartbeats that ran.
type RunLoopActivity struct {
	At          time.Duration
	Activity    string
	DefaultMode bool
	HasTimer    bool
	TimerIn     time.Duration
	SentInWait  uint64
	Answered    uint64
}

var runLoopActivityNames = map[int32]string{
	int32(testabi.SP_HOST_TEST_RUN_LOOP_ENTRY):          "entry",
	int32(testabi.SP_HOST_TEST_RUN_LOOP_BEFORE_TIMERS):  "timers",
	int32(testabi.SP_HOST_TEST_RUN_LOOP_BEFORE_SOURCES): "sources",
	int32(testabi.SP_HOST_TEST_RUN_LOOP_BEFORE_WAITING): "wait",
	int32(testabi.SP_HOST_TEST_RUN_LOOP_AFTER_WAITING):  "wake",
	int32(testabi.SP_HOST_TEST_RUN_LOOP_EXIT):           "exit",
}

// StartRunLoopRecorder installs the recorder of the main run loop at its first call and keeps every activity from now on.
func StartRunLoopRecorder() {
	functions := requireNativeFunctions()
	functions.SpHostTestRecorderStart()
}

// StopRunLoopRecorder stops keeping activities and returns those that it kept, in their order; it fails when the recorder could
// not keep every activity.
func StopRunLoopRecorder() ([]RunLoopActivity, error) {
	functions, err := installedNativeFunctions()
	if err != nil {
		return nil, err
	}
	count := uint64(functions.SpHostTestRecorderStop())
	activities := make([]RunLoopActivity, 0, count)
	for index := uint64(0); index < count; index++ {
		var at uint64
		var activity, defaultMode, hasTimer int32
		var timerIn int64
		var sentInWait, answered uint64
		if functions.SpHostTestRecorderEntryAt(uint64(index), &at, &activity, &defaultMode, &hasTimer, &timerIn, &sentInWait, &answered) == 0 {
			return activities, fmt.Errorf("run loop recorder: entry %d is incomplete", index)
		}
		name, known := runLoopActivityNames[int32(activity)]
		if !known {
			name = fmt.Sprintf("activity %d", int(activity))
		}
		activities = append(activities, RunLoopActivity{time.Duration(at), name, defaultMode != 0, hasTimer != 0, time.Duration(timerIn),
			uint64(sentInWait), uint64(answered)})
	}
	if dropped := uint64(functions.SpHostTestRecorderDropped()); dropped > 0 {
		return activities, fmt.Errorf("run loop recorder: %d activities beyond its %d", dropped, int(testabi.SP_HOST_TEST_RECORDER_CAPACITY))
	}
	return activities, nil
}

// StallCounts are the counts of the stall watch of the native library since the start of the process: the heartbeats that sent
// their block to the main thread, those whose wake reached a run loop that waited, and the blocks that ran.
type StallCounts struct {
	Sent, SentInWait, Answered uint64
}

// ReadStallCounts returns the counts of the stall watch.
func ReadStallCounts() StallCounts {
	functions := requireNativeFunctions()
	var sent, sentInWait, answered uint64
	functions.SpHostTestReadStallCounts(&sent, &sentInWait, &answered)
	return StallCounts{uint64(sent), uint64(sentInWait), uint64(answered)}
}

// SetSendInNextWait sets the fault injection of the watch: the next wait of the watch that finds the run loop waiting sends a
// heartbeat into it instead of blocking.
func SetSendInNextWait(send bool) {
	functions := requireNativeFunctions()
	functions.SpHostTestSetSendInNextWait(bool(send))
}

// StackBounds returns the lowest and the highest address of the stack of the main thread.
func StackBounds() (low, high uintptr) {
	functions := requireNativeFunctions()
	return uintptr(functions.SpHostTestSamplerStackLow()), uintptr(functions.SpHostTestSamplerStackHigh())
}

// StallCheckOptions are the parts of the stall check. Start starts the stall watch of the host (StartStallWatch of the Go language
// host library, whose tests import this package, so the test passes it in) with the heartbeat and the function that receives the
// name of each event that the watch stores, and returns its stop; Heartbeat is the heartbeat of the platform; Step runs Go code
// for a duration as one main-thread step of the host; Log writes a line of the test; SendInWait is the fault injection of a watch
// that sends one heartbeat into a wait of the run loop.
type StallCheckOptions struct {
	Start      func(heartbeat func() (now, answered time.Duration), emit func(name string)) (stop func())
	Heartbeat  func() (now, answered time.Duration)
	Step       func(time.Duration) error
	Log        func(format string, args ...any)
	SendInWait bool
}

// StallCheck holds the judgments of the second in which the main run loop waits (docs/spec/host-contract.md,
// host.stall.waiting-run-loop-takes-no-heartbeat): SameWait, a heartbeat that read the wait that the heartbeat before it read;
// SentInWait, a send of the watch whose wake reached a waiting run loop; WokeByWatch, a wake of the run loop that ended a wait
// into which the watch sent; Stored, a stall record of that second. Each is nil when the run meets it.
type StallCheck struct {
	SameWait, SentInWait, WokeByWatch, Stored error
}

// Err joins the judgments that failed.
func (check StallCheck) Err() error {
	return errors.Join(check.SameWait, check.SentInWait, check.WokeByWatch, check.Stored)
}

// stallBeat is one heartbeat of the stall watch: the time of the call and its lateness on the clock of the heartbeat, where a
// heartbeat that read a wait of the run loop has the start of that wait as its time and no lateness, and the clock time at which it
// returned.
type stallBeat struct {
	now, late time.Duration
	at        time.Time
}

// CheckStallWatch runs the stall watch of the host over the main run loop with the heartbeat of the platform. A step of 600 ms
// keeps the run loop handling an event while the heartbeats go on, and stores no stall; then the run loop waits, and the second
// after the heartbeat that read the wait is judged; then a step of 1.6 s is a stall whose end is recorded. The run loop recorder
// keeps every activity from the first step to the end of the judged second, and Log states each heartbeat and each turn of that
// second. The returned error is a failure of the run outside the judgments of the waiting run loop.
func CheckStallWatch(options StallCheckOptions) (StallCheck, error) {
	var emittedLock sync.Mutex
	var emitted []string
	names := func() string {
		emittedLock.Lock()
		defer emittedLock.Unlock()
		return strings.Join(emitted, ",")
	}
	// Each heartbeat of the watch, in its order. waited receives the index of the first heartbeat that reads a wait of the run
	// loop once the check armed it with waitArmed; beatsLock holds the three.
	var beatsLock sync.Mutex
	var beats []stallBeat
	waited := make(chan int, 1)
	waitArmed := false
	resumed := make(chan struct{}, 1)
	stop := options.Start(func() (time.Duration, time.Duration) {
		now, answered := options.Heartbeat()
		beatsLock.Lock()
		defer beatsLock.Unlock()
		beats = append(beats, stallBeat{now, now - answered, time.Now()})
		if now == answered && waitArmed {
			waitArmed = false
			waited <- len(beats) - 1
		}
		return now, answered
	}, func(name string) {
		emittedLock.Lock()
		defer emittedLock.Unlock()
		emitted = append(emitted, name)
		if name == "host.stall.resumed" {
			select {
			case resumed <- struct{}{}:
			default:
			}
		}
	})
	defer stop()
	beatsFrom := func(index int) []stallBeat {
		beatsLock.Lock()
		defer beatsLock.Unlock()
		return append([]stallBeat(nil), beats[index:]...)
	}
	// The fault injection is cleared at the end, so a run that ends before the watch waits leaves it to no other check.
	defer SetSendInNextWait(false)
	before := ReadStallCounts()
	StartRunLoopRecorder()
	recording := true
	defer func() {
		if recording {
			StopRunLoopRecorder()
		}
	}()
	SetSendInNextWait(options.SendInWait)
	// A step that does not end in time for the next beat wakes the watch, and the heartbeats go on while it runs. A short step
	// does not stall.
	if err := options.Step(600 * time.Millisecond); err != nil {
		return StallCheck{}, err
	}
	stepEnd := time.Now()
	if len(beatsFrom(0)) == 0 {
		return StallCheck{}, fmt.Errorf("no heartbeat in a step of 600 ms on the main thread")
	}
	if got := names(); got != "" {
		return StallCheck{}, fmt.Errorf("the stall watch stored %s for a step of 600 ms", got)
	}
	// The run loop then waits, and the watch reads the wait with its next heartbeat. The last heartbeat may already have read it.
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
		return StallCheck{}, fmt.Errorf("no heartbeat read a wait of the run loop within 10 s of the step; heartbeats %s",
			stallBeats(beatsFrom(0), 0))
	}
	var settling []string
	for _, beat := range beatsFrom(0)[:settled+1] {
		if beat.at.After(stepEnd) {
			settling = append(settling, fmt.Sprintf("+%v late %v", beat.at.Sub(stepEnd).Round(time.Millisecond), beat.late))
		}
	}
	options.Log("stall heartbeat: after the step, %s", strings.Join(settling, ", "))
	// Through a wait the watch blocks and sends nothing: a heartbeat that reads a wait returns the start of that wait and sends
	// nothing, the watch sends its next heartbeat only after the run loop woke from it, and no send of the watch reaches a waiting
	// run loop. Whatever else wakes the run loop is outside the watch, and the recorder states each wake.
	time.Sleep(time.Second)
	recording = false
	activities, recorded := StopRunLoopRecorder()
	if recorded != nil {
		return StallCheck{}, recorded
	}
	after := ReadStallCounts()
	judged := beatsFrom(settled)
	turns, wokeByWatch := runLoopTurns(activities, judged[0].now)
	heartbeats := stallBeats(judged[1:], judged[0].now)
	options.Log("stall heartbeat: from the wait that a heartbeat read, %d heartbeats in a second: %s; from the first step, the watch sent %d heartbeats, %d into a wait, and %d of their blocks ran; the run loop: %s",
		len(judged)-1, heartbeats, after.Sent-before.Sent, after.SentInWait-before.SentInWait, after.Answered-before.Answered, turns)
	var check StallCheck
	for index := 1; index < len(judged); index++ {
		previous, current := judged[index-1], judged[index]
		if previous.late == 0 && current.late == 0 && current.now == previous.now {
			check.SameWait = fmt.Errorf("heartbeat %d of the second read the wait that the heartbeat before it read, so the watch sent it through that wait; from that wait, heartbeats %s; the run loop: %s",
				index, heartbeats, turns)
			break
		}
	}
	if sent := after.SentInWait - before.SentInWait; sent != 0 {
		check.SentInWait = fmt.Errorf("the watch sent %d heartbeats into a wait of the run loop from the first step; the run loop: %s", sent, turns)
	}
	if wokeByWatch > 0 {
		check.WokeByWatch = fmt.Errorf("%d wakes of the run loop ended a wait into which the watch sent; the run loop: %s", wokeByWatch, turns)
	}
	if got := names(); got != "" {
		check.Stored = fmt.Errorf("the stall watch stored %s in the second after the heartbeat that read the wait; the run loop: %s", got, turns)
	}
	// A step that holds the main thread is a stall, and its end is recorded.
	if err := options.Step(1600 * time.Millisecond); err != nil {
		return check, err
	}
	select {
	case <-resumed:
	case <-time.After(5 * time.Second):
	}
	if got := names(); got != "host.stall,host.stall.sampled,host.stall.resumed" {
		return check, fmt.Errorf("the stall watch stored %q for a step of 1.6 s", got)
	}
	return check, nil
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

// runLoopTurns states the turns of the main run loop that the recorder kept, each time after from (negative before it): each wake
// with its mode, the start of the wait that it ended, the next timer of that wait and the sends of the watch into that wait, then
// the activities of the turn and the number of blocks of the watch that ran in it, up to its next wait. It also returns the number
// of wakes that ended a wait into which the watch sent.
func runLoopTurns(activities []RunLoopActivity, from time.Duration) (string, int) {
	var turns, turn []string
	var wait, wake *RunLoopActivity
	wokeByWatch := 0
	end := func(next *RunLoopActivity) {
		if len(turn) == 0 {
			return
		}
		if wake != nil && next != nil {
			turn = append(turn, fmt.Sprintf("(%d blocks of the watch)", next.Answered-wake.Answered))
		}
		turns = append(turns, strings.Join(turn, " "))
		turn = nil
	}
	after := func(at time.Duration) time.Duration { return (at - from).Round(time.Microsecond) }
	for index := range activities {
		activity := &activities[index]
		switch {
		case activity.Activity == "wait":
			turn = append(turn, "wait")
			end(activity)
			wait, wake = activity, nil
		case activity.Activity == "wake":
			end(nil)
			wake = activity
			mode := "the default mode"
			if !activity.DefaultMode {
				mode = "another mode"
			}
			ended, timer, sent := "a wait before the recorder", "no timer", ""
			if wait != nil {
				ended = fmt.Sprintf("the wait from %v", after(wait.At))
				if wait.HasTimer {
					timer = fmt.Sprintf("a timer due at %v", after(wait.At+wait.TimerIn))
				}
				if activity.SentInWait > wait.SentInWait {
					sent = fmt.Sprintf(", into which the watch sent %d", activity.SentInWait-wait.SentInWait)
					wokeByWatch++
				}
			}
			turn = append(turn, fmt.Sprintf("wake at %v in %s, ending %s with %s%s:", after(activity.At), mode, ended, timer, sent))
		default:
			turn = append(turn, activity.Activity)
		}
	}
	end(nil)
	if len(turns) == 0 {
		return "no turn", wokeByWatch
	}
	return strings.Join(turns, "; "), wokeByWatch
}
