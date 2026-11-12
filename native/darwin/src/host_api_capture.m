#include "host_api_capture.h"

#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include "capture.h"
#include "surface_layout.h"
#include "notifications.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callbacks run their Go functions on the worker, and the native calls of this file that use AppKit or WebKit run on the main
// thread (main_thread.h). The capture functions of capture.h need no thread: the host calls those that do not wait directly, and
// the capture calls that wait or read the windows on the main thread run on a queue of their own (scheduleCapture*).
static void deliveredNotificationsBridge(void *context, const char *json) {
    hostRunOnWorker(^{ sp_host_diagnostic_callback_delivered_notifications((uintptr_t)context, (char *)json); });
}
void listDeliveredNotifications(void) {
    hostRunOnMain(^{ sp_notifications_delivered(deliveredNotificationsBridge, NULL); });
}
#import <Cocoa/Cocoa.h>

// Records at most max window server numbers of this window and the windows attached to it, and returns the number recorded.
// The capture tool names a window by this number, so it reads the page, surfaces and modals composited by the window server without
// moving the window to the front. The window number of this app comes first.
static int windowNumbersOnMain(void* nsWindow, long* out, int max) {
    NSWindow* window = (NSWindow*)nsWindow;
    if (window == nil || max <= 0) return 0;
    int n = 0;
    out[n++] = (long)[window windowNumber];
    for (NSWindow* child in [window childWindows]) {
        if (n >= max) break;
        out[n++] = (long)[child windowNumber];
    }
    return n;
}
int windowNumbers(uintptr_t nsWindow, long* out, int max) { return ON_MAIN(int, windowNumbersOnMain((void *)nsWindow, out, max)); }
// The capture calls that wait or read the windows on the main thread (open, start, stop, still) run on a queue of their own and
// answer their context with one capture_answered callback on the worker, so neither the main thread nor the worker waits for
// them: the window close and the page end that end their waits (endCaptureWait) reach the main thread while they wait. The answer
// carries the result of the call and its failure: the error of an open, a start or a still, or the error of the recording after
// a stop.
static dispatch_queue_t captureCalls(void) {
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ queue = dispatch_queue_create("soksak.capture.calls", DISPATCH_QUEUE_CONCURRENT); });
    return queue;
}
static void answerCapture(uintptr_t context, long result, char *failure) {
    hostRunOnWorker(^{
        sp_host_diagnostic_callback_capture_answered(context, result, failure);
        free(failure);
    });
}
static void answerRecording(uintptr_t context, long result) {
    const char *recording = sp_capture_error();
    answerCapture(context, result, recording != NULL && recording[0] != 0 ? strdup(recording) : NULL);
}
void scheduleCaptureOpen(long windowNumber, bool display, uintptr_t context) {
    dispatch_async(captureCalls(), ^{
        @autoreleasepool {
            char *error = NULL;
            bool prepared = sp_capture_open(windowNumber, display, &error);
            answerCapture(context, prepared, error);
        }
    });
}
void scheduleCaptureStart(const char *directory, double gap, double seconds, int frames, uint64_t token, uintptr_t context) {
    char *folder = directory != NULL ? strdup(directory) : NULL;
    dispatch_async(captureCalls(), ^{
        @autoreleasepool {
            char *error = NULL;
            bool started = sp_capture_start(folder, gap, seconds, frames, token, &error);
            free(folder);
            answerCapture(context, started, error);
        }
    });
}
bool main_sp_capture_hold_new_window(char **error) { return ON_MAIN(bool, sp_capture_hold_new_window(error)); }
void scheduleCaptureWaitNewWindow(uint64_t token, uintptr_t context) {
    dispatch_async(captureCalls(), ^{
        @autoreleasepool {
            long number = sp_capture_wait_new_window(token);
            answerCapture(context, number, number < 0 ? strdup(sp_capture_error() ?: "no new window was shown") : NULL);
        }
    });
}
void releaseCaptureNewWindow(void) { sp_capture_release_new_window(); }
void scheduleCaptureStop(double after, uint64_t token, uintptr_t context) {
    dispatch_async(captureCalls(), ^{
        @autoreleasepool { answerRecording(context, sp_capture_stop(after, token)); }
    });
}
void scheduleCaptureStill(long windowNumber, const char *path, uintptr_t context) {
    char *target = path != NULL ? strdup(path) : NULL;
    dispatch_async(captureCalls(), ^{
        @autoreleasepool {
            char *error = NULL;
            bool written = sp_capture_still(windowNumber, target, &error);
            free(target);
            answerCapture(context, written, error);
        }
    });
}
void endCaptureWait(uint64_t token, const char *reason) { sp_capture_end_wait(token, reason); }
void main_surfaceLayoutTraceStart(void) { hostRunOnMain(^{ surfaceLayoutTraceStart(); }); }
size_t main_surfaceLayoutTraceStop(double *out, size_t capacity) {
    return ON_MAIN(size_t, surfaceLayoutTraceStop(out, capacity));
}
uint64_t main_surfaceLayoutTraceRequested(void) { return ON_MAIN(uint64_t, surfaceLayoutTraceRequested()); }
void main_surfaceLayoutTracePresented(uint64_t ticket) { hostRunOnMain(^{ surfaceLayoutTracePresented(ticket); }); }
