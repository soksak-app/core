//go:build darwin

// Package darwin samples the stack pointer of the main thread for the tests of the Go framework adapters (docs/spec/hosts.md, main
// thread of the Wails host). The sampler reads the stack pointer of the main thread as the collector of a JavaScriptCore VM reads it when it scans a
// thread (captureStack in MachineStackMarker.cpp): it suspends the thread with thread_suspend, reads its registers with
// thread_get_state and resumes it. A sample whose stack pointer lies outside the stack of the main thread is a moment in which
// the main thread runs on a stack that the Go heap holds. The package also records the activities of the main run loop with the
// counts of the stall watch of the native library, and runs the stall check that the tests of both adapters make.
package darwin

/*
#cgo pkg-config: soksak-darwin
#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <mach/mach.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>
#include "stall_watch.h"

#define SAMPLER_PHASES 8

static mach_port_t sampler_port;
static uintptr_t sampler_low;
static uintptr_t sampler_high;
static pthread_t sampler_thread;
static _Atomic int sampler_running;
static _Atomic int sampler_phase = -1;
static _Atomic uint64_t sampler_samples[SAMPLER_PHASES];
static _Atomic uint64_t sampler_outside[SAMPLER_PHASES];
static _Atomic uintptr_t sampler_first_outside[SAMPLER_PHASES];
static _Atomic uint64_t sampler_failures;
static _Atomic int sampler_last_error;

static kern_return_t sampler_stack_pointer(mach_port_t port, uintptr_t *sp) {
#if defined(__arm64__)
    arm_thread_state64_t state;
    mach_msg_type_number_t count = ARM_THREAD_STATE64_COUNT;
    kern_return_t result = thread_get_state(port, ARM_THREAD_STATE64, (thread_state_t)&state, &count);
    if (result == KERN_SUCCESS) *sp = (uintptr_t)arm_thread_state64_get_sp(state);
#elif defined(__x86_64__)
    x86_thread_state64_t state;
    mach_msg_type_number_t count = x86_THREAD_STATE64_COUNT;
    kern_return_t result = thread_get_state(port, x86_THREAD_STATE64, (thread_state_t)&state, &count);
    if (result == KERN_SUCCESS) *sp = (uintptr_t)state.__rsp;
#else
#error "the sampler reads the stack pointer of arm64 and x86_64 only"
#endif
    return result;
}

static void sampler_fail(kern_return_t result) {
    atomic_fetch_add(&sampler_failures, 1);
    atomic_store(&sampler_last_error, (int)result);
}

// The loop takes no lock and allocates nothing while the main thread is suspended, because the main thread may hold the lock
// of the allocator when it is suspended. The main thread reports no event when it switches stacks, so the loop samples on a
// fixed interval of 20 microseconds.
static void *sampler_loop(void *unused) {
    (void)unused;
    while (atomic_load(&sampler_running)) {
        int phase = atomic_load(&sampler_phase);
        if (phase >= 0 && phase < SAMPLER_PHASES) {
            kern_return_t result = thread_suspend(sampler_port);
            if (result != KERN_SUCCESS) {
                sampler_fail(result);
            } else {
                uintptr_t sp = 0;
                kern_return_t read = sampler_stack_pointer(sampler_port, &sp);
                kern_return_t resumed = thread_resume(sampler_port);
                if (read != KERN_SUCCESS) {
                    sampler_fail(read);
                } else {
                    atomic_fetch_add(&sampler_samples[phase], 1);
                    if (sp < sampler_low || sp > sampler_high) {
                        if (atomic_fetch_add(&sampler_outside[phase], 1) == 0) atomic_store(&sampler_first_outside[phase], sp);
                    }
                }
                if (resumed != KERN_SUCCESS) sampler_fail(resumed);
            }
        }
        usleep(20);
    }
    return NULL;
}

static pthread_t sampler_main;

// The main thread calls this, so that the sampler reads that thread; it returns 0 on any other thread.
static int sampler_capture_main(void) {
    if (!pthread_main_np()) return 0;
    sampler_main = pthread_self();
    return 1;
}

static int sampler_start(void) {
    pthread_t main = sampler_main;
    if (main == NULL) return -1;
    sampler_port = pthread_mach_thread_np(main);
    sampler_high = (uintptr_t)pthread_get_stackaddr_np(main);
    sampler_low = sampler_high - (uintptr_t)pthread_get_stacksize_np(main);
    atomic_store(&sampler_running, 1);
    int result = pthread_create(&sampler_thread, NULL, sampler_loop, NULL);
    if (result != 0) atomic_store(&sampler_running, 0);
    return result;
}

static int sampler_stop(void) {
    atomic_store(&sampler_phase, -1);
    atomic_store(&sampler_running, 0);
    return pthread_join(sampler_thread, NULL);
}

static void sampler_set_phase(int phase) { atomic_store(&sampler_phase, phase); }
static uint64_t sampler_phase_samples(int phase) { return atomic_load(&sampler_samples[phase]); }
static uint64_t sampler_phase_outside(int phase) { return atomic_load(&sampler_outside[phase]); }
static uintptr_t sampler_phase_first_outside(int phase) { return atomic_load(&sampler_first_outside[phase]); }
static uint64_t sampler_failure_count(void) { return atomic_load(&sampler_failures); }
static int sampler_failure_last(void) { return atomic_load(&sampler_last_error); }
static uintptr_t sampler_stack_low(void) { return sampler_low; }
static uintptr_t sampler_stack_high(void) { return sampler_high; }

// The recorder of the main run loop keeps each activity of the run loop while it is armed: the time on the clock of the heartbeat
// of the stall watch (CLOCK_UPTIME_RAW), the activity, whether the run loop runs in its default mode, at the start of a wait the
// time until the next timer of the mode, so a wake can be told from the timer that it fired, and the counts of the stall watch
// (sp_stall_counts), so a turn states whether the watch sent into the wait before it and whether a block of the watch ran in it.
// The observer is a C function and writes into a fixed array, so it runs no Go code on the main thread and allocates nothing.
#define RECORDER_CAPACITY 4096

typedef struct {
    uint64_t at;
    int64_t timer_in;
    int32_t activity;
    int32_t default_mode;
    int32_t has_timer;
    uint64_t sent_in_wait;
    uint64_t answered;
    _Atomic int32_t written;
} recorder_entry;

static recorder_entry recorder_entries[RECORDER_CAPACITY];
static _Atomic uint64_t recorder_next;
static _Atomic int recorder_armed;

static void recorder_observe(CFRunLoopObserverRef observer, CFRunLoopActivity activity, void *info) {
    (void)observer;
    (void)info;
    if (!atomic_load(&recorder_armed)) return;
    uint64_t index = atomic_fetch_add(&recorder_next, 1);
    if (index >= RECORDER_CAPACITY) return;
    recorder_entry *entry = &recorder_entries[index];
    entry->at = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
    entry->activity = (int32_t)activity;
    CFRunLoopRef main = CFRunLoopGetMain();
    CFStringRef mode = CFRunLoopCopyCurrentMode(main);
    entry->default_mode = mode != NULL && CFEqual(mode, kCFRunLoopDefaultMode);
    entry->has_timer = 0;
    entry->timer_in = 0;
    if (activity == kCFRunLoopBeforeWaiting && mode != NULL) {
        CFAbsoluteTime fire = CFRunLoopGetNextTimerFireDate(main, mode);
        if (fire != 0) {
            entry->has_timer = 1;
            entry->timer_in = (int64_t)((fire - CFAbsoluteTimeGetCurrent()) * 1e9);
        }
    }
    if (mode != NULL) CFRelease(mode);
    uint64_t sent = 0;
    sp_stall_counts(&sent, &entry->sent_in_wait, &entry->answered);
    atomic_store_explicit(&entry->written, 1, memory_order_release);
}

// Installs the observer once, in the common modes of the main run loop, and arms the recorder with an empty array.
static void recorder_start(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        CFRunLoopObserverRef observer = CFRunLoopObserverCreate(NULL, kCFRunLoopAllActivities, true, 0, recorder_observe, NULL);
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, kCFRunLoopCommonModes);
        CFRelease(observer);
    });
    atomic_store(&recorder_armed, 0);
    uint64_t used = atomic_load(&recorder_next);
    for (uint64_t index = 0; index < used && index < RECORDER_CAPACITY; index++) atomic_store(&recorder_entries[index].written, 0);
    atomic_store(&recorder_next, 0);
    atomic_store(&recorder_armed, 1);
}

// Disarms the recorder and returns the number of activities that it kept; an activity that the array could not hold is not kept.
static uint64_t recorder_stop(void) {
    atomic_store(&recorder_armed, 0);
    uint64_t used = atomic_load(&recorder_next);
    return used < RECORDER_CAPACITY ? used : RECORDER_CAPACITY;
}

static uint64_t recorder_dropped(void) {
    uint64_t used = atomic_load(&recorder_next);
    return used > RECORDER_CAPACITY ? used - RECORDER_CAPACITY : 0;
}

// Copies one kept activity; it returns 0 for an activity that the observer has not finished writing.
static int recorder_entry_at(uint64_t index, uint64_t *at, int32_t *activity, int32_t *default_mode, int32_t *has_timer,
    int64_t *timer_in, uint64_t *sent_in_wait, uint64_t *answered) {
    recorder_entry *entry = &recorder_entries[index];
    if (!atomic_load_explicit(&entry->written, memory_order_acquire)) return 0;
    *at = entry->at;
    *activity = entry->activity;
    *default_mode = entry->default_mode;
    *has_timer = entry->has_timer;
    *timer_in = entry->timer_in;
    *sent_in_wait = entry->sent_in_wait;
    *answered = entry->answered;
    return 1;
}

*/
import "C"

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Phases is the number of phases that the sampler counts apart.
const Phases = int(C.SAMPLER_PHASES)

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
	if C.sampler_capture_main() == 0 {
		return fmt.Errorf("sampler: the calling thread is not the main thread")
	}
	return nil
}

// StartSampler starts the thread that samples the main thread. It samples only while a phase is set.
func StartSampler() error {
	if result := C.sampler_start(); result != 0 {
		return fmt.Errorf("sampler: pthread_create returned %d", int(result))
	}
	return nil
}

// SetPhase sets the phase that the next samples count for; -1 stops the sampling.
func SetPhase(phase int) {
	if phase >= Phases {
		panic(fmt.Sprintf("sampler: phase %d is not below %d", phase, Phases))
	}
	C.sampler_set_phase(C.int(phase))
}

// StopSampler ends the sampling thread and returns the count of each phase. A failed suspend, read or resume is an error, with the
// number of failures and the last kernel result.
func StopSampler() ([]PhaseCount, error) {
	if result := C.sampler_stop(); result != 0 {
		return nil, fmt.Errorf("sampler: pthread_join returned %d", int(result))
	}
	counts := make([]PhaseCount, Phases)
	for phase := range counts {
		counts[phase] = PhaseCount{
			Samples:      uint64(C.sampler_phase_samples(C.int(phase))),
			Outside:      uint64(C.sampler_phase_outside(C.int(phase))),
			FirstOutside: uintptr(C.sampler_phase_first_outside(C.int(phase))),
		}
	}
	if failures := uint64(C.sampler_failure_count()); failures > 0 {
		return counts, fmt.Errorf("sampler: %d thread calls failed, the last with kernel result %d", failures, int(C.sampler_failure_last()))
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
	int32(C.kCFRunLoopEntry):         "entry",
	int32(C.kCFRunLoopBeforeTimers):  "timers",
	int32(C.kCFRunLoopBeforeSources): "sources",
	int32(C.kCFRunLoopBeforeWaiting): "wait",
	int32(C.kCFRunLoopAfterWaiting):  "wake",
	int32(C.kCFRunLoopExit):          "exit",
}

// StartRunLoopRecorder installs the recorder of the main run loop at its first call and keeps every activity from now on.
func StartRunLoopRecorder() { C.recorder_start() }

// StopRunLoopRecorder stops keeping activities and returns those that it kept, in their order; it fails when the recorder could
// not keep every activity.
func StopRunLoopRecorder() ([]RunLoopActivity, error) {
	count := uint64(C.recorder_stop())
	activities := make([]RunLoopActivity, 0, count)
	for index := uint64(0); index < count; index++ {
		var at C.uint64_t
		var activity, defaultMode, hasTimer C.int32_t
		var timerIn C.int64_t
		var sentInWait, answered C.uint64_t
		if C.recorder_entry_at(C.uint64_t(index), &at, &activity, &defaultMode, &hasTimer, &timerIn, &sentInWait, &answered) == 0 {
			continue
		}
		name, known := runLoopActivityNames[int32(activity)]
		if !known {
			name = fmt.Sprintf("activity %d", int(activity))
		}
		activities = append(activities, RunLoopActivity{time.Duration(at), name, defaultMode != 0, hasTimer != 0, time.Duration(timerIn),
			uint64(sentInWait), uint64(answered)})
	}
	if dropped := uint64(C.recorder_dropped()); dropped > 0 {
		return activities, fmt.Errorf("run loop recorder: %d activities beyond its %d", dropped, int(C.RECORDER_CAPACITY))
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
	var sent, sentInWait, answered C.uint64_t
	C.sp_stall_counts(&sent, &sentInWait, &answered)
	return StallCounts{uint64(sent), uint64(sentInWait), uint64(answered)}
}

// SetSendInNextWait sets the fault injection of the watch: the next wait of the watch that finds the run loop waiting sends a
// heartbeat into it instead of blocking.
func SetSendInNextWait(send bool) { C.sp_stall_set_send_in_next_wait_for_test(C.bool(send)) }

// StackBounds returns the lowest and the highest address of the stack of the main thread.
func StackBounds() (low, high uintptr) {
	return uintptr(C.sampler_stack_low()), uintptr(C.sampler_stack_high())
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
