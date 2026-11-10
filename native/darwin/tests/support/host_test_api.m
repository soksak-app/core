#include "host_test_api.h"
#include <Block.h>
#include <stdio.h>
#include <stdlib.h>

static void (*installedCounts)(uint64_t *, uint64_t *, uint64_t *);
static void (*installedSetter)(bool);
static bool stallFunctionsInstalled;

const char *sp_host_test_install_stall_functions(uintptr_t counts, uintptr_t setter) {
    if (stallFunctionsInstalled) return "host test stall functions are already installed";
    if (!counts) return "host test stall count function is missing";
    if (!setter) return "host test stall setter function is missing";
    installedCounts = (void (*)(uint64_t *, uint64_t *, uint64_t *))counts;
    installedSetter = (void (*)(bool))setter;
    stallFunctionsInstalled = true;
    return NULL;
}

static void requireStallFunctions(void) {
    if (stallFunctionsInstalled) return;
    fputs("host test stall functions are not installed\n", stderr);
    abort();
}

void sp_host_test_read_stall_counts(uint64_t *sent, uint64_t *sent_in_wait, uint64_t *answered) {
    requireStallFunctions();
    installedCounts(sent, sent_in_wait, answered);
}

void sp_host_test_set_send_in_next_wait(bool send) {
    requireStallFunctions();
    installedSetter(send);
}

static void runDirectly(void (^work)(void)) { work(); }
uintptr_t sp_host_test_direct_runner_address(void) { return (uintptr_t)runDirectly; }

#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <mach/mach.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>


#define SAMPLER_PHASES SP_HOST_TEST_SAMPLER_PHASES

static mach_port_t sampler_port;
static uintptr_t sampler_low;
static uintptr_t sampler_high;
static pthread_t sampler_thread;
static _Atomic int sampler_running;
static _Atomic int sampler_phase = -1;
static _Atomic uint64_t sampler_samples[SAMPLER_PHASES];
// The count of samples that sp_host_test_sampler_await_samples waits for in each phase, 0 for none, and the semaphore that the
// sample which reaches it signals.
static _Atomic uint64_t sampler_awaited[SAMPLER_PHASES];
static dispatch_semaphore_t sampler_sampled;
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
                    uint64_t taken = atomic_fetch_add(&sampler_samples[phase], 1) + 1;
                    if (taken == atomic_load(&sampler_awaited[phase])) dispatch_semaphore_signal(sampler_sampled);
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
int sp_host_test_sampler_capture_main(void) {
    if (!pthread_main_np()) return 0;
    sampler_main = pthread_self();
    return 1;
}

int sp_host_test_sampler_start(void) {
    pthread_t main = sampler_main;
    if (main == NULL) return -1;
    if (sampler_sampled == NULL) sampler_sampled = dispatch_semaphore_create(0);
    sampler_port = pthread_mach_thread_np(main);
    sampler_high = (uintptr_t)pthread_get_stackaddr_np(main);
    sampler_low = sampler_high - (uintptr_t)pthread_get_stacksize_np(main);
    atomic_store(&sampler_running, 1);
    int result = pthread_create(&sampler_thread, NULL, sampler_loop, NULL);
    if (result != 0) atomic_store(&sampler_running, 0);
    return result;
}

int sp_host_test_sampler_stop(void) {
    atomic_store(&sampler_phase, -1);
    atomic_store(&sampler_running, 0);
    return pthread_join(sampler_thread, NULL);
}

void sp_host_test_sampler_set_phase(int phase) { atomic_store(&sampler_phase, phase); }
uint64_t sp_host_test_sampler_phase_samples(int phase) { return atomic_load(&sampler_samples[phase]); }

void sp_host_test_sampler_await_samples(int phase, uint64_t count) {
    atomic_store(&sampler_awaited[phase], count);
    // A sample that reached the count before the store above is seen here; one after it signals.
    while (atomic_load(&sampler_samples[phase]) < count) dispatch_semaphore_wait(sampler_sampled, DISPATCH_TIME_FOREVER);
    atomic_store(&sampler_awaited[phase], 0);
}
uint64_t sp_host_test_sampler_phase_outside(int phase) { return atomic_load(&sampler_outside[phase]); }
uintptr_t sp_host_test_sampler_phase_first_outside(int phase) { return atomic_load(&sampler_first_outside[phase]); }
uint64_t sp_host_test_sampler_failure_count(void) { return atomic_load(&sampler_failures); }
int sp_host_test_sampler_failure_last(void) { return atomic_load(&sampler_last_error); }
uintptr_t sp_host_test_sampler_stack_low(void) { return sampler_low; }
uintptr_t sp_host_test_sampler_stack_high(void) { return sampler_high; }

// The recorder of the main run loop keeps each activity of the run loop while it is armed: the time on the clock of the heartbeat
// of the stall watch (CLOCK_UPTIME_RAW), the activity, whether the run loop runs in its default mode, at the start of a wait the
// time until the next timer of the mode, so a wake can be told from the timer that it fired, and the counts of the stall watch
// (sp_stall_counts), so a turn states whether the watch sent into the wait before it and whether a block of the watch ran in it.
// The observer is a C function and writes into a fixed array, so it runs no Go code on the main thread and allocates nothing.
#define RECORDER_CAPACITY SP_HOST_TEST_RECORDER_CAPACITY

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
    sp_host_test_read_stall_counts(&sent, &entry->sent_in_wait, &entry->answered);
    atomic_store_explicit(&entry->written, 1, memory_order_release);
}

// Installs the observer once, in the common modes of the main run loop, and arms the recorder with an empty array.
void sp_host_test_recorder_start(void) {
    requireStallFunctions();
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
uint64_t sp_host_test_recorder_stop(void) {
    atomic_store(&recorder_armed, 0);
    uint64_t used = atomic_load(&recorder_next);
    return used < RECORDER_CAPACITY ? used : RECORDER_CAPACITY;
}

uint64_t sp_host_test_recorder_dropped(void) {
    uint64_t used = atomic_load(&recorder_next);
    return used > RECORDER_CAPACITY ? used - RECORDER_CAPACITY : 0;
}

// Copies one kept activity; it returns 0 for an activity that the observer has not finished writing.
int sp_host_test_recorder_entry_at(uint64_t index, uint64_t *at, int32_t *activity, int32_t *default_mode, int32_t *has_timer,
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

#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurfaceRef.h>

static CFNumberRef number(int value) { return CFNumberCreate(NULL, kCFNumberIntType, &value); }

// frameCreate creates a BGRA surface that carries the nonce of a transfer image.
static IOSurfaceRef frameCreate(int width, int height, const unsigned char *nonce) {
	const void *keys[] = {kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement, kIOSurfacePixelFormat};
	const void *values[] = {number(width), number(height), number(4), number('BGRA')};
	CFDictionaryRef properties = CFDictionaryCreate(NULL, keys, values, 4, &kCFTypeDictionaryKeyCallBacks,
		&kCFTypeDictionaryValueCallBacks);
	for (int index = 0; index < 4; index++) CFRelease(values[index]);
	IOSurfaceRef surface = IOSurfaceCreate(properties);
	CFRelease(properties);
	if (!surface) return NULL;
	CFDataRef data = CFDataCreate(NULL, nonce, 16);
	IOSurfaceSetValue(surface, CFSTR("soksak.frame"), data);
	CFRelease(data);
	return surface;
}

void *sp_host_test_frame_create(int width, int height, const unsigned char *nonce) { return (void *)frameCreate(width, height, nonce); }
uint32_t sp_host_test_frame_id(void *frame) { return IOSurfaceGetID((IOSurfaceRef)frame); }
bool sp_host_test_frame_in_use(void *frame) { return IOSurfaceIsInUse((IOSurfaceRef)frame) != 0; }
void sp_host_test_frame_release(void *frame) { CFRelease((CFTypeRef)frame); }
