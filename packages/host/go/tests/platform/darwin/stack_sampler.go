//go:build darwin

// Package darwin samples the stack pointer of the main thread for the tests of the Go framework adapters (docs/spec/hosts.md, main
// thread of the Wails host). The sampler reads the stack pointer of the main thread as the collector of a JavaScriptCore VM reads it when it scans a
// thread (captureStack in MachineStackMarker.cpp): it suspends the thread with thread_suspend, reads its registers with
// thread_get_state and resumes it. A sample whose stack pointer lies outside the stack of the main thread is a moment in which
// the main thread runs on a stack that the Go heap holds. The package also records the activities of the main run loop, so a test
// can state what woke a run loop that it expects to wait.
package darwin

/*
#cgo LDFLAGS: -framework CoreFoundation
#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <mach/mach.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>

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
// of the stall watch (CLOCK_UPTIME_RAW), the activity, whether the run loop runs in its default mode, and at the start of a wait
// the time until the next timer of the mode, so a wake can be told from the timer that it fired. The observer is a C function
// and writes into a fixed array, so it runs no Go code on the main thread and allocates nothing.
#define RECORDER_CAPACITY 4096

typedef struct {
    uint64_t at;
    int64_t timer_in;
    int32_t activity;
    int32_t default_mode;
    int32_t has_timer;
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
    int64_t *timer_in) {
    recorder_entry *entry = &recorder_entries[index];
    if (!atomic_load_explicit(&entry->written, memory_order_acquire)) return 0;
    *at = entry->at;
    *activity = entry->activity;
    *default_mode = entry->default_mode;
    *has_timer = entry->has_timer;
    *timer_in = entry->timer_in;
    return 1;
}

*/
import "C"

import (
	"fmt"
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
// watch, its name, whether the run loop ran in its default mode, and at the start of a wait the time until the next timer of the
// mode (TimerIn, when HasTimer).
type RunLoopActivity struct {
	At          time.Duration
	Activity    string
	DefaultMode bool
	HasTimer    bool
	TimerIn     time.Duration
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
		if C.recorder_entry_at(C.uint64_t(index), &at, &activity, &defaultMode, &hasTimer, &timerIn) == 0 {
			continue
		}
		name, known := runLoopActivityNames[int32(activity)]
		if !known {
			name = fmt.Sprintf("activity %d", int(activity))
		}
		activities = append(activities, RunLoopActivity{time.Duration(at), name, defaultMode != 0, hasTimer != 0, time.Duration(timerIn)})
	}
	if dropped := uint64(C.recorder_dropped()); dropped > 0 {
		return activities, fmt.Errorf("run loop recorder: %d activities beyond its %d", dropped, int(C.RECORDER_CAPACITY))
	}
	return activities, nil
}

// StackBounds returns the lowest and the highest address of the stack of the main thread.
func StackBounds() (low, high uintptr) {
	return uintptr(C.sampler_stack_low()), uintptr(C.sampler_stack_high())
}
