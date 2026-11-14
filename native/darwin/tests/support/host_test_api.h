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

// A window is a retained borderless NSWindow with a content view of the given size in points. It is not ordered on screen, is not
// released when closed, and its address is the platform Window handle of the darwin layer. AppKit requires the main thread: both
// functions refuse on another thread, with an error message and without changing any state (creation sets its result to NULL),
// and so do a size that is not positive and finite and a missing result address. Both return NULL or an error message. Close each window exactly once: it
// closes the window and releases the reference of the creation.
const char *sp_host_test_window_create(double width, double height, void **window);
// The window that both frameworks give the host: the window of sp_host_test_window_create with the title bar styles of a framework
// window (title, close, miniaturize and resize controls, a hidden title bar over a content view that fills the window), so the
// operations of the platform on the title bar and the window controls run on it. It is not ordered on screen. The same rules of the
// thread, the arguments, the result and the close apply, and the close is sp_host_test_window_close.
const char *sp_host_test_window_create_titled(double width, double height, void **window);
const char *sp_host_test_window_close(void *window);
// The main web view that a framework gives its window: a WKWebView that fills the content view of the window and loads the page
// fixture of the fixture folder (native/darwin/tests/fixtures, named at build time), which is a file name without a path. The web
// view belongs to the content view and closes with its window. The creation runs on the main thread and starts the load; it sets
// its result to NULL and returns an error message for a missing window, address or content view, a name that is not a file name of
// the folder, and a load that cannot start. The platform registers the web view as the main web view of the window (SetMainWebview).
// sp_host_test_webview_loaded waits on a thread that is not the main thread, so that the main thread delivers the navigation, until
// the page loaded, and returns NULL or the error message of the load; it can be called again and returns the same result.
const char *sp_host_test_window_main_webview(uintptr_t window, const char *fixture, void **webview);
const char *sp_host_test_webview_loaded(void *webview);

// Releases the presentation waits that the fault point SOKSAK_FAULT_VIEW_PRESENTATION=hold of the production library holds
// (native/darwin/src/webview.m): a wait that began before the release delivers its callback on the main thread once its real
// presentation update came, and a wait that begins after the release is held until the next release while the point is set.
// Returns NULL or an error message.
const char *sp_host_test_view_presentation_release(void);

// Reads of the production library for the host tests; each runs on the main thread, refuses another thread, a missing window, region
// or address with an error message, and refuses when the production library is not linked into the process. Each returns NULL or an
// error message.
// The number of image region views (native/darwin/src/image_region.m) that the window holds below its content view.
const char *sp_host_test_window_image_regions(uintptr_t window, uint64_t *count);
// The key wait of the window (native/darwin/src/surface_layout.m): waiting is whether the keys of the window wait, decision whether they
// wait for the decision of the workbench, and modal whether they wait for a modal web view.
const char *sp_host_test_window_keys_wait(uintptr_t window, bool *waiting, bool *decision, bool *modal);
// Opens the key wait of the window as the release of a press on the workbench does (the opener of native/darwin/src/surface_layout.m),
// with the wait for the decision set when decision is true.
const char *sp_host_test_window_open_key_wait(uintptr_t window, bool decision);
// Presents a fresh IOSurface of the native raster size of the region, which is in the lease presentation mode and placed in a laid-out
// surface, with the identity generation, raster and sequence, so that the region holds the surface and its close, or a later frame,
// runs the release callback of the lease with that identity. The test owns no reference of the surface after the call.
const char *sp_host_test_region_present_lease(void *region, uint64_t generation, uint64_t raster, int sequence);

// A child started with its crash exceptions answered by a test service: the exceptions are answered as handled, so the system
// writes no crash report for them. The arguments are newline-separated after path; environment is NAME=VALUE, added to the
// inherited environment. Standard output and standard error go to output_fd. Returns NULL or an error message.
const char *sp_host_test_spawn_handled_crash(const char *path, const char *arguments, const char *environment, int output_fd,
    int *pid, uintptr_t *handle);
// Waits for the child, ends the service, and writes the raw wait status and the number of answered crash exceptions.
const char *sp_host_test_wait_handled_crash(uintptr_t handle, int *status, int *handled);
