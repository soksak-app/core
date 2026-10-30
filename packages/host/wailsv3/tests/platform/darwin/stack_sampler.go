//go:build darwin

// Package darwin holds the tests of the main thread of the Wails host on macOS (docs/spec/hosts.md, main thread of the Wails
// host). The sampler reads the stack pointer of the main thread as the collector of a JavaScriptCore VM reads it when it scans a
// thread (captureStack in MachineStackMarker.cpp): it suspends the thread with thread_suspend, reads its registers with
// thread_get_state and resumes it. A sample whose stack pointer lies outside the stack of the main thread is a moment in which
// the main thread runs on a stack that the Go heap holds.
package darwin

/*
#include <mach/mach.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
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

*/
import "C"

import "fmt"

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

// StackBounds returns the lowest and the highest address of the stack of the main thread.
func StackBounds() (low, high uintptr) {
	return uintptr(C.sampler_stack_low()), uintptr(C.sampler_stack_high())
}
