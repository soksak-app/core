#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <CoreFoundation/CFRunLoop.h>

// Test-only native primitives; no production state or Go callbacks live in this library.
enum {
    SP_HOST_TEST_SAMPLER_PHASES = 8,
    SP_HOST_TEST_RECORDER_CAPACITY = 4096,
    SP_HOST_TEST_RUN_LOOP_ENTRY = kCFRunLoopEntry,
    SP_HOST_TEST_RUN_LOOP_BEFORE_TIMERS = kCFRunLoopBeforeTimers,
    SP_HOST_TEST_RUN_LOOP_BEFORE_SOURCES = kCFRunLoopBeforeSources,
    SP_HOST_TEST_RUN_LOOP_BEFORE_WAITING = kCFRunLoopBeforeWaiting,
    SP_HOST_TEST_RUN_LOOP_AFTER_WAITING = kCFRunLoopAfterWaiting,
    SP_HOST_TEST_RUN_LOOP_EXIT = kCFRunLoopExit,
};

// The two production addresses are borrowed for process lifetime and copied once.
// Missing addresses and replacement return static errors without changing installed state.
const char *sp_host_test_install_stall_functions(uintptr_t counts, uintptr_t setter);
void sp_host_test_read_stall_counts(uint64_t *sent, uint64_t *sent_in_wait, uint64_t *answered);
void sp_host_test_set_send_in_next_wait(bool send);

// Capture must run on the native main thread. Sampling reads that thread entirely in native code.
// Each successful start after capture requires one stop/join. Phase is -1 to pause or [0, SAMPLER_PHASES);
// phase query indices are [0, SAMPLER_PHASES). The caller owns the lifecycle and serializes its transitions.
int sp_host_test_sampler_capture_main(void);
int sp_host_test_sampler_start(void);
int sp_host_test_sampler_stop(void);
void sp_host_test_sampler_set_phase(int phase);
uint64_t sp_host_test_sampler_phase_samples(int phase);
// Blocks until the running sampler took count samples of phase; the sample that reaches the count wakes it.
void sp_host_test_sampler_await_samples(int phase, uint64_t count);
uint64_t sp_host_test_sampler_phase_outside(int phase);
uintptr_t sp_host_test_sampler_phase_first_outside(int phase);
uint64_t sp_host_test_sampler_failure_count(void);
int sp_host_test_sampler_failure_last(void);
uintptr_t sp_host_test_sampler_stack_low(void);
uintptr_t sp_host_test_sampler_stack_high(void);

// The observer runs only native code, uses the injected production counts, and writes a bounded array.
void sp_host_test_recorder_start(void);
uint64_t sp_host_test_recorder_stop(void);
uint64_t sp_host_test_recorder_dropped(void);
// Entry index must be below the stopped count. Returns 0 if its native writer has not finished.
int sp_host_test_recorder_entry_at(uint64_t index, uint64_t *at, int32_t *activity, int32_t *default_mode,
    int32_t *has_timer, int64_t *timer_in, uint64_t *sent_in_wait, uint64_t *answered);

// Standalone tests alone use this address; framework consumers retain their actual dispatchers.
uintptr_t sp_host_test_direct_runner_address(void);

// A frame is a retained IOSurface with its 16-byte transfer nonce. Release exactly once.
void *sp_host_test_frame_create(int width, int height, const unsigned char *nonce);
uint32_t sp_host_test_frame_id(void *frame);
bool sp_host_test_frame_in_use(void *frame);
void sp_host_test_frame_release(void *frame);

// A child started with its crash exceptions answered by a test service: the exceptions are answered as handled, so the system
// writes no crash report for them. The arguments are newline-separated after path; environment is NAME=VALUE, added to the
// inherited environment. Standard output and standard error go to output_fd. Returns NULL or an error message.
const char *sp_host_test_spawn_handled_crash(const char *path, const char *arguments, const char *environment, int output_fd,
    int *pid, uintptr_t *handle);
// Waits for the child, ends the service, and writes the raw wait status and the number of answered crash exceptions.
const char *sp_host_test_wait_handled_crash(uintptr_t handle, int *status, int *handled);
