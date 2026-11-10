//go:build darwin && diagnostics

package darwin

// Records a window. The recording implementation is capture.m of native/darwin. It is included only in diagnostic builds.

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	"math"

	"strings"
	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

func captureError(operation string) error {
	message := native.GoString(diagnosticNative.SpCaptureError())
	if message == "" {
		return fmt.Errorf("capture %s failed without a native reason", operation)
	}
	return fmt.Errorf("capture %s: %s", operation, message)
}

// Reads and releases the prepare, start and stop capture errors that the caller owns.
func captureCallError(operation string, success bool, nativeError *byte) error {
	if nativeError != nil {
		defer native.Free(unsafe.Pointer(nativeError))
		return fmt.Errorf("capture %s: %s", operation, native.GoString(nativeError))
	}
	if !success {
		return fmt.Errorf("capture %s failed without a native reason", operation)
	}
	return nil
}

func (implementation) WindowNumbers(window platform.Window) ([]int, error) {
	var buf [32]int64
	n := int(diagnosticNative.WindowNumbers(uintptr(window), &buf[0], int32(len(buf))))
	out := make([]int, n)
	for i := 0; i < n; i++ {
		out[i] = int(buf[i])
	}
	return out, nil
}

func (implementation) CaptureOpen(windowNumber int, display bool) error {
	var nativeError *byte
	prepared := bool(diagnosticNative.SpCaptureOpen(int64(windowNumber), bool(display), &nativeError))
	return captureCallError("open", prepared, nativeError)
}

func (implementation) CaptureStart(directory string, frameIdentity bool) error {
	if strings.IndexByte(directory, 0) >= 0 {
		return errors.New("capture start: directory contains NUL")
	}
	where := native.CString(directory)
	defer native.Free(unsafe.Pointer(where))
	var nativeError *byte
	started := bool(diagnosticNative.SpCaptureStart(where, bool(frameIdentity), &nativeError))
	return captureCallError("start", started, nativeError)
}

func (implementation) CaptureStop(after float64) (int, error) {
	frames := int(diagnosticNative.SpCaptureStop(float64(after)))
	if err := captureErrorIfPresent("stop"); err != nil {
		return frames, err
	}
	return frames, nil
}

// CaptureHasStream reports whether the capture module still owns its current stream and writer transaction.
func (implementation) CaptureHasStream() (bool, error) {
	return bool(diagnosticNative.SpCaptureHasStream()), nil
}

func captureErrorIfPresent(operation string) error {
	message := native.GoString(diagnosticNative.SpCaptureError())
	if message == "" {
		return nil
	}
	return fmt.Errorf("capture %s: %s", operation, message)
}

func (implementation) CaptureWait() (bool, error) {
	if diagnosticNative.SpCaptureWait() != 0 {
		return true, nil
	}
	return false, captureError("wait")
}

func (implementation) CaptureEndWaits() { diagnosticNative.SpCaptureEndWaits() }

func (implementation) CaptureLimited() bool { return bool(diagnosticNative.SpCaptureLimited()) }

func (implementation) CaptureLongestGap() float64 {
	return float64(diagnosticNative.SpCaptureLongestGap())
}

func (implementation) CaptureClock() float64 { return float64(diagnosticNative.SpCaptureClock()) }

// deliveredDone receives the result of the notification query in progress.
var deliveredDone func(string)

func goHost_delivered_notifications(_ uintptr, json *byte) {
	deliveredDone(native.GoString(json))
}

func (implementation) DeliveredNotifications(done func(json string)) {
	deliveredDone = done
	diagnosticNative.ListDeliveredNotifications()
}

func (implementation) LayoutTraceStart() { diagnosticNative.MainSurfaceLayoutTraceStart() }

func (implementation) LayoutTraceRequested() (presented func()) {
	ticket := diagnosticNative.MainSurfaceLayoutTraceRequested()
	return func() { diagnosticNative.MainSurfaceLayoutTracePresented(ticket) }
}

func (implementation) LayoutTraceStop() ([]platform.LayoutRecord, error) {
	const capacity = 4096
	values := make([]float64, capacity*abi.SURFACE_LAYOUT_TRACE_STAGES)
	count := int(diagnosticNative.MainSurfaceLayoutTraceStop(&values[0], capacity))
	if count > capacity {
		return nil, fmt.Errorf("layout trace capacity exceeded: %d records, capacity %d", count, capacity)
	}
	return layoutRecords(values, count)
}

// layoutCommitPaths names each commit path code of the native layout trace.
var layoutCommitPaths = map[float64]string{
	abi.SURFACE_LAYOUT_COMMIT_PRESENT:      "present",
	abi.SURFACE_LAYOUT_COMMIT_START:        "start",
	abi.SURFACE_LAYOUT_COMMIT_VIEW_JOIN:    "view-join",
	abi.SURFACE_LAYOUT_COMMIT_VIEW_ABANDON: "view-abandon",
	abi.SURFACE_LAYOUT_COMMIT_CANCEL:       "cancel",
}

// layoutRecords reads count native layout records of SURFACE_LAYOUT_TRACE_STAGES values each: ticket, begun, presented,
// committed, requested, commit path code and open at commit. A code that the native code does not declare is an error.
func layoutRecords(values []float64, count int) ([]platform.LayoutRecord, error) {
	records := make([]platform.LayoutRecord, count)
	for i := range records {
		value := values[i*abi.SURFACE_LAYOUT_TRACE_STAGES : (i+1)*abi.SURFACE_LAYOUT_TRACE_STAGES]
		path := ""
		if !math.IsNaN(value[5]) {
			name, ok := layoutCommitPaths[value[5]]
			if !ok {
				return nil, fmt.Errorf("layout transaction %d has the unknown commit path %v", uint64(value[0]), value[5])
			}
			path = name
		}
		records[i] = platform.LayoutRecord{
			Ticket: uint64(value[0]), Begun: value[1], Presented: value[2], Committed: value[3], Requested: value[4],
			CommitPath: path, OpenAtCommit: value[6],
		}
	}
	return records, nil
}

func (implementation) CaptureStill(windowNumbers []int, path string) error {
	if strings.IndexByte(path, 0) >= 0 {
		return errors.New("still capture: path contains NUL")
	}
	if len(windowNumbers) == 0 {
		return errors.New("still capture needs the number of a window")
	}
	numbers := make([]int64, len(windowNumbers))
	for i, number := range windowNumbers {
		numbers[i] = int64(number)
	}
	target := native.CString(path)
	defer native.Free(unsafe.Pointer(target))
	var nativeError *byte
	written := bool(diagnosticNative.SpCaptureStill(&numbers[0], int32(len(numbers)), target, &nativeError))
	return captureCallError("still", written, nativeError)
}
func (implementation) StartDocumentFrameIdentity(document unsafe.Pointer, generation uint64, done func(json.RawMessage, error)) error {
	if done == nil {
		return errors.New("start document frame identity: completion callback is nil")
	}
	handle := handles.NewHandle(done)
	if !bool(diagnosticNative.ScheduleDocumentFrameIdentityStart(document, uint64(generation), uintptr(handle))) {
		handle.Delete()
		return errors.New("start document frame identity was not scheduled")
	}
	return nil
}

func (implementation) FreezeDocumentFrameIdentity(generation uint64, done func(json.RawMessage, error)) error {
	return scheduleDocumentFrameIdentity("freeze", generation, done, func(handle uintptr) bool {
		return bool(diagnosticNative.ScheduleDocumentFrameIdentityFreeze(uint64(generation), handle))
	})
}

func (implementation) RemoveDocumentFrameIdentity(generation uint64, done func(json.RawMessage, error)) error {
	return scheduleDocumentFrameIdentity("remove", generation, done, func(handle uintptr) bool {
		return bool(diagnosticNative.ScheduleDocumentFrameIdentityRemove(uint64(generation), handle))
	})
}

func scheduleDocumentFrameIdentity(operation string, generation uint64, done func(json.RawMessage, error), schedule func(uintptr) bool) error {
	if done == nil {
		return fmt.Errorf("%s document frame identity: completion callback is nil", operation)
	}
	handle := handles.NewHandle(done)
	if !schedule(uintptr(handle)) {
		handle.Delete()
		return fmt.Errorf("%s document frame identity was not scheduled", operation)
	}
	return nil
}

func goHost_document_frame_identity_done(context uintptr, reply *byte, nativeError *byte) {
	handle := handles.Handle(context)
	done := handle.Value().(func(json.RawMessage, error))
	handle.Delete()
	if nativeError != nil {
		done(nil, errors.New(native.GoString(nativeError)))
		return
	}
	if reply == nil {
		done(nil, errors.New("document frame identity callback returned no reply"))
		return
	}
	done(json.RawMessage(native.GoString(reply)), nil)
}
