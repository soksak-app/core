#include "host_api_capture.h"

#include <stdlib.h>
#include <stdint.h>
#include "capture.h"
#include "surface_layout.h"
#include "notifications.h"
#include "document_view.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callbacks run their Go functions on the worker, and the native calls of this file that use AppKit, WebKit or the capture
// state run on the main thread (main_thread.h). The capture clock and the capture error need no thread.
static void documentFrameIdentityDoneBridge(void *context, const char *json, const char *error) {
	hostRunOnWorker(^{ sp_host_diagnostic_callback_document_frame_identity_done((uintptr_t)context, (char *)json, (char *)error); });
}
bool scheduleDocumentFrameIdentityStart(void *document, uint64_t generation, uintptr_t context) {
	return ON_MAIN(bool, sp_document_frame_identity_start(document, generation, documentFrameIdentityDoneBridge, (void *)context));
}
bool scheduleDocumentReferenceIdentityStart(void *document, uint64_t generation, uintptr_t context) {
	return ON_MAIN(bool, sp_document_reference_identity_start(document, generation, documentFrameIdentityDoneBridge, (void *)context));
}
bool scheduleDocumentReferenceObserve(void *document, uint64_t requestId, const char *directory, uintptr_t context) {
	return ON_MAIN(bool, sp_document_reference_observe(document, requestId, directory, documentFrameIdentityDoneBridge, (void *)context));
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
bool main_sp_capture_open(long windowNumber, bool display, char **error) {
    return ON_MAIN(bool, sp_capture_open(windowNumber, display, error));
}
bool main_sp_capture_start(const char *directory, bool frameIdentity, char **error) {
    return ON_MAIN(bool, sp_capture_start(directory, frameIdentity, error));
}
int main_sp_capture_stop(double after) { return ON_MAIN(int, sp_capture_stop(after)); }
bool main_sp_capture_has_stream(void) { return ON_MAIN(bool, sp_capture_has_stream()); }
int main_sp_capture_wait(void) { return ON_MAIN(int, sp_capture_wait()); }
bool main_sp_capture_limited(void) { return ON_MAIN(bool, sp_capture_limited()); }
double main_sp_capture_longest_gap(void) { return ON_MAIN(double, sp_capture_longest_gap()); }
bool main_sp_capture_still(const long *windowNumbers, int count, const char *path, char **error) {
    return ON_MAIN(bool, sp_capture_still(windowNumbers, count, path, error));
}
void main_surfaceLayoutTraceStart(void) { hostRunOnMain(^{ surfaceLayoutTraceStart(); }); }
size_t main_surfaceLayoutTraceStop(double *out, size_t capacity) {
    return ON_MAIN(size_t, surfaceLayoutTraceStop(out, capacity));
}
uint64_t main_surfaceLayoutTraceRequested(void) { return ON_MAIN(uint64_t, surfaceLayoutTraceRequested()); }
void main_surfaceLayoutTracePresented(uint64_t ticket) { hostRunOnMain(^{ surfaceLayoutTracePresented(ticket); }); }
