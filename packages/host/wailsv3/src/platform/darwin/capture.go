//go:build darwin && diagnostics

package darwin

// Records a window. The recording implementation is capture.m of native/darwin. It is included only in diagnostic builds.

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include <stdint.h>
#include "capture.h"
#include "surface_layout.h"
#include "notifications.h"
#include "document_view.h"
#include "main_thread.h"

// The callbacks run their Go functions on the worker, and the native calls of this file that use AppKit, WebKit or the capture
// state run on the main thread (main_thread.h). The capture clock and the capture error need no thread.
extern void goDocumentFrameIdentityDone(uintptr_t context, char *json, char *error);
static void documentFrameIdentityDoneBridge(void *context, const char *json, const char *error) {
	wailsRunOnWorker(^{ goDocumentFrameIdentityDone((uintptr_t)context, (char *)json, (char *)error); });
}
static bool scheduleDocumentFrameIdentityStart(void *document, uint64_t generation, uintptr_t context) {
	return ON_MAIN(bool, sp_document_frame_identity_start(document, generation, documentFrameIdentityDoneBridge, (void *)context));
}
static bool scheduleDocumentFrameIdentityFreeze(uint64_t generation, uintptr_t context) {
	return ON_MAIN(bool, sp_document_frame_identity_freeze(generation, documentFrameIdentityDoneBridge, (void *)context));
}
static bool scheduleDocumentFrameIdentityRemove(uint64_t generation, uintptr_t context) {
	return ON_MAIN(bool, sp_document_frame_identity_remove(generation, documentFrameIdentityDoneBridge, (void *)context));
}

extern void goDeliveredNotifications(void *context, char *json);
static void deliveredNotificationsBridge(void *context, const char *json) {
    wailsRunOnWorker(^{ goDeliveredNotifications(context, (char *)json); });
}
static void listDeliveredNotifications(void) {
    wailsRunOnMain(^{ sp_notifications_delivered(deliveredNotificationsBridge, NULL); });
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
static int windowNumbers(void* nsWindow, long* out, int max) { return ON_MAIN(int, windowNumbersOnMain(nsWindow, out, max)); }
static bool main_sp_capture_open(long windowNumber, bool display, char **error) {
    return ON_MAIN(bool, sp_capture_open(windowNumber, display, error));
}
static bool main_sp_capture_start(const char *directory, bool frameIdentity, char **error) {
    return ON_MAIN(bool, sp_capture_start(directory, frameIdentity, error));
}
static int main_sp_capture_stop(double after) { return ON_MAIN(int, sp_capture_stop(after)); }
static bool main_sp_capture_has_stream(void) { return ON_MAIN(bool, sp_capture_has_stream()); }
static int main_sp_capture_wait(void) { return ON_MAIN(int, sp_capture_wait()); }
static bool main_sp_capture_limited(void) { return ON_MAIN(bool, sp_capture_limited()); }
static double main_sp_capture_longest_gap(void) { return ON_MAIN(double, sp_capture_longest_gap()); }
static bool main_sp_capture_still(long windowNumber, const char *path, char **error) {
    return ON_MAIN(bool, sp_capture_still(windowNumber, path, error));
}
static void main_surfaceLayoutTraceStart(void) { wailsRunOnMain(^{ surfaceLayoutTraceStart(); }); }
static size_t main_surfaceLayoutTraceStop(double *out, size_t capacity) {
    return ON_MAIN(size_t, surfaceLayoutTraceStop(out, capacity));
}
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime/cgo"
	"strings"
	"unsafe"
)

func captureError(operation string) error {
	message := C.GoString(C.sp_capture_error())
	if message == "" {
		return fmt.Errorf("capture %s failed without a native reason", operation)
	}
	return fmt.Errorf("capture %s: %s", operation, message)
}

// Reads and releases the prepare, start and stop capture errors that the caller owns.
func captureCallError(operation string, success bool, nativeError *C.char) error {
	if nativeError != nil {
		defer C.free(unsafe.Pointer(nativeError))
		return fmt.Errorf("capture %s: %s", operation, C.GoString(nativeError))
	}
	if !success {
		return fmt.Errorf("capture %s failed without a native reason", operation)
	}
	return nil
}

func (implementation) WindowNumbers(window unsafe.Pointer) ([]int, error) {
	var buf [32]C.long
	n := int(C.windowNumbers(window, &buf[0], C.int(len(buf))))
	out := make([]int, n)
	for i := 0; i < n; i++ {
		out[i] = int(buf[i])
	}
	return out, nil
}

func (implementation) CaptureOpen(windowNumber int, display bool) error {
	var nativeError *C.char
	prepared := bool(C.main_sp_capture_open(C.long(windowNumber), C.bool(display), &nativeError))
	return captureCallError("open", prepared, nativeError)
}

func (implementation) CaptureStart(directory string, frameIdentity bool) error {
	if strings.IndexByte(directory, 0) >= 0 {
		return errors.New("capture start: directory contains NUL")
	}
	where := C.CString(directory)
	defer C.free(unsafe.Pointer(where))
	var nativeError *C.char
	started := bool(C.main_sp_capture_start(where, C.bool(frameIdentity), &nativeError))
	return captureCallError("start", started, nativeError)
}

func (implementation) CaptureStop(after float64) (int, error) {
	frames := int(C.main_sp_capture_stop(C.double(after)))
	if err := captureErrorIfPresent("stop"); err != nil {
		return frames, err
	}
	return frames, nil
}

// CaptureHasStream reports whether the capture module still owns its current stream and writer transaction.
func (implementation) CaptureHasStream() (bool, error) {
	return bool(C.main_sp_capture_has_stream()), nil
}

func captureErrorIfPresent(operation string) error {
	message := C.GoString(C.sp_capture_error())
	if message == "" {
		return nil
	}
	return fmt.Errorf("capture %s: %s", operation, message)
}

func (implementation) CaptureWait() (bool, error) {
	if C.main_sp_capture_wait() != 0 {
		return true, nil
	}
	return false, captureError("wait")
}

func (implementation) CaptureLimited() bool { return bool(C.main_sp_capture_limited()) }

func (implementation) CaptureLongestGap() float64 { return float64(C.main_sp_capture_longest_gap()) }

func (implementation) CaptureClock() float64 { return float64(C.sp_capture_clock()) }

// deliveredDone receives the result of the notification query in progress.
var deliveredDone func(string)

//export goDeliveredNotifications
func goDeliveredNotifications(_ unsafe.Pointer, json *C.char) {
	deliveredDone(C.GoString(json))
}

func (implementation) DeliveredNotifications(done func(json string)) {
	deliveredDone = done
	C.listDeliveredNotifications()
}

func (implementation) LayoutTraceStart() { C.main_surfaceLayoutTraceStart() }

func (implementation) LayoutTraceStop() ([][5]float64, error) {
	const capacity = 4096
	values := make([]C.double, capacity*C.SURFACE_LAYOUT_TRACE_STAGES)
	count := int(C.main_surfaceLayoutTraceStop(&values[0], capacity))
	if count > capacity {
		return nil, fmt.Errorf("layout trace capacity exceeded: %d records, capacity %d", count, capacity)
	}
	records := make([][5]float64, count)
	for i := range records {
		for j := 0; j < C.SURFACE_LAYOUT_TRACE_STAGES; j++ {
			records[i][j] = float64(values[i*C.SURFACE_LAYOUT_TRACE_STAGES+j])
		}
	}
	return records, nil
}

func (implementation) CaptureStill(windowNumber int, path string) error {
	if strings.IndexByte(path, 0) >= 0 {
		return errors.New("still capture: path contains NUL")
	}
	target := C.CString(path)
	defer C.free(unsafe.Pointer(target))
	var nativeError *C.char
	written := bool(C.main_sp_capture_still(C.long(windowNumber), target, &nativeError))
	return captureCallError("still", written, nativeError)
}
func (implementation) StartDocumentFrameIdentity(document unsafe.Pointer, generation uint64, done func(json.RawMessage, error)) error {
	if done == nil {
		return errors.New("start document frame identity: completion callback is nil")
	}
	handle := cgo.NewHandle(done)
	if !bool(C.scheduleDocumentFrameIdentityStart(document, C.uint64_t(generation), C.uintptr_t(handle))) {
		handle.Delete()
		return errors.New("start document frame identity was not scheduled")
	}
	return nil
}

func (implementation) FreezeDocumentFrameIdentity(generation uint64, done func(json.RawMessage, error)) error {
	return scheduleDocumentFrameIdentity("freeze", generation, done, func(handle C.uintptr_t) bool {
		return bool(C.scheduleDocumentFrameIdentityFreeze(C.uint64_t(generation), handle))
	})
}

func (implementation) RemoveDocumentFrameIdentity(generation uint64, done func(json.RawMessage, error)) error {
	return scheduleDocumentFrameIdentity("remove", generation, done, func(handle C.uintptr_t) bool {
		return bool(C.scheduleDocumentFrameIdentityRemove(C.uint64_t(generation), handle))
	})
}

func scheduleDocumentFrameIdentity(operation string, generation uint64, done func(json.RawMessage, error), schedule func(C.uintptr_t) bool) error {
	if done == nil {
		return fmt.Errorf("%s document frame identity: completion callback is nil", operation)
	}
	handle := cgo.NewHandle(done)
	if !schedule(C.uintptr_t(handle)) {
		handle.Delete()
		return fmt.Errorf("%s document frame identity was not scheduled", operation)
	}
	return nil
}

//export goDocumentFrameIdentityDone
func goDocumentFrameIdentityDone(context C.uintptr_t, reply *C.char, nativeError *C.char) {
	handle := cgo.Handle(context)
	done := handle.Value().(func(json.RawMessage, error))
	handle.Delete()
	if nativeError != nil {
		done(nil, errors.New(C.GoString(nativeError)))
		return
	}
	if reply == nil {
		done(nil, errors.New("document frame identity callback returned no reply"))
		return
	}
	done(json.RawMessage(C.GoString(reply)), nil)
}
