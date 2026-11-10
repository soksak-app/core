#include "host_api_capture.h"

#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include "capture.h"
#include "surface_layout.h"
#include "notifications.h"
#include "document_view.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callbacks run their Go functions on the worker, and the native calls of this file that use AppKit or WebKit run on the main
// thread (main_thread.h). The capture functions of capture.h need no thread: the host calls those that do not wait directly, and
// the capture calls that wait run on a queue of their own (scheduleCapture*).
static void documentFrameIdentityDoneBridge(void *context, const char *json, const char *error) {
	hostRunOnWorker(^{ sp_host_diagnostic_callback_document_frame_identity_done((uintptr_t)context, (char *)json, (char *)error); });
}
bool scheduleDocumentFrameIdentityStart(void *document, uint64_t generation, uintptr_t context) {
	return ON_MAIN(bool, sp_document_frame_identity_start(document, generation, documentFrameIdentityDoneBridge, (void *)context));
}
bool scheduleDocumentFrameIdentityFreeze(uint64_t generation, uintptr_t context) {
	return ON_MAIN(bool, sp_document_frame_identity_freeze(generation, documentFrameIdentityDoneBridge, (void *)context));
}
bool scheduleDocumentFrameIdentityRemove(uint64_t generation, uintptr_t context) {
	return ON_MAIN(bool, sp_document_frame_identity_remove(generation, documentFrameIdentityDoneBridge, (void *)context));
}

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
// The capture calls that wait (open, wait, stop, still) run on a queue of their own and answer their context with one
// capture_answered callback on the worker, so neither the main thread nor the worker waits for them: the window close and
// the page end that end their waits (endCaptureWait) reach the main thread while they wait. The answer carries the result
// of the call and its failure: the error of an open or a still, or the error of the recording after a wait or a stop.
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
void scheduleCaptureOpen(long windowNumber, bool display, uint64_t token, uintptr_t context) {
    dispatch_async(captureCalls(), ^{
        @autoreleasepool {
            char *error = NULL;
            bool prepared = sp_capture_open(windowNumber, display, token, &error);
            answerCapture(context, prepared, error);
        }
    });
}
void scheduleCaptureWait(uint64_t token, uintptr_t context) {
    dispatch_async(captureCalls(), ^{
        @autoreleasepool { answerRecording(context, sp_capture_wait(token)); }
    });
}
void scheduleCaptureStop(double after, uint64_t token, uintptr_t context) {
    dispatch_async(captureCalls(), ^{
        @autoreleasepool { answerRecording(context, sp_capture_stop(after, token)); }
    });
}
void scheduleCaptureStill(const long *windowNumbers, int count, const char *path, uint64_t token, uintptr_t context) {
    long *numbers = NULL;
    if (windowNumbers != NULL && count > 0) {
        numbers = malloc(sizeof(long) * (size_t)count);
        // A loop of assignments copies the numbers, so the function calls no native function on the calling thread.
        if (numbers != NULL) for (int index = 0; index < count; index++) numbers[index] = windowNumbers[index];
    }
    char *target = path != NULL ? strdup(path) : NULL;
    int held = numbers != NULL ? count : 0;
    dispatch_async(captureCalls(), ^{
        @autoreleasepool {
            char *error = NULL;
            bool written = sp_capture_still(numbers, held, target, token, &error);
            free(numbers);
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
