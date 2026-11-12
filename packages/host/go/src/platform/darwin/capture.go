//go:build darwin && diagnostics

package darwin

// Records a window. The recording implementation is capture.m of native/darwin. It is included only in diagnostic builds.

import (
	"errors"
	"fmt"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	"math"

	"strings"
	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// Reads and releases the capture error of a call that the caller owns.
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

// captureAnswer is the answer of a capture call that waits: its result and its failure, which the native code owns.
type captureAnswer struct {
	result  int64
	failure string
	failed  bool
}

// awaitCaptureAnswer schedules a capture call that waits with a new context and waits on the calling goroutine for its one
// capture_answered callback. The call waits on a native thread of its own, so the main thread and the worker go on.
func awaitCaptureAnswer(schedule func(context uintptr)) captureAnswer {
	answered := make(chan captureAnswer, 1)
	handle := handles.NewHandle(func(answer captureAnswer) { answered <- answer })
	schedule(uintptr(handle))
	return <-answered
}

func goHost_capture_answered(context uintptr, result int64, failure *byte) {
	handle := handles.Handle(context)
	done := handle.Value().(func(captureAnswer))
	handle.Delete()
	done(captureAnswer{result: result, failure: native.GoString(failure), failed: failure != nil})
}

// captureAnswerError is the error of the answer of an open or a still.
func captureAnswerError(operation string, answer captureAnswer) error {
	if answer.failed {
		return fmt.Errorf("capture %s: %s", operation, answer.failure)
	}
	if answer.result == 0 {
		return fmt.Errorf("capture %s failed without a native reason", operation)
	}
	return nil
}

func (implementation) CaptureOpen(windowNumber int, display bool) error {
	answer := awaitCaptureAnswer(func(context uintptr) {
		diagnosticNative.ScheduleCaptureOpen(int64(windowNumber), bool(display), context)
	})
	return captureAnswerError("open", answer)
}

func (implementation) CaptureStart(directory string, gap, seconds float64, frames int, token uint64) error {
	if strings.IndexByte(directory, 0) >= 0 {
		return errors.New("capture start: directory contains NUL")
	}
	where := native.CString(directory)
	defer native.Free(unsafe.Pointer(where))
	answer := awaitCaptureAnswer(func(context uintptr) {
		diagnosticNative.ScheduleCaptureStart(where, float64(gap), float64(seconds), int32(frames), token, context)
	})
	return captureAnswerError("start", answer)
}

func (implementation) CaptureStop(after float64, token uint64) (int, error) {
	answer := awaitCaptureAnswer(func(context uintptr) { diagnosticNative.ScheduleCaptureStop(float64(after), token, context) })
	if answer.failed {
		return int(answer.result), fmt.Errorf("capture stop: %s", answer.failure)
	}
	return int(answer.result), nil
}

// CaptureHoldNewWindow holds the next show of a window that is not on screen. The caller runs it in a step of the main thread.
func (implementation) CaptureHoldNewWindow() error {
	var nativeError *byte
	held := bool(diagnosticNative.MainSpCaptureHoldNewWindow(&nativeError))
	return captureCallError("hold of a new window", held, nativeError)
}

// CaptureWaitNewWindow waits until a show was held and returns the window server number of that window.
func (implementation) CaptureWaitNewWindow(token uint64) (int, error) {
	answer := awaitCaptureAnswer(func(context uintptr) { diagnosticNative.ScheduleCaptureWaitNewWindow(token, context) })
	if answer.failed {
		return -1, errors.New(answer.failure)
	}
	return int(answer.result), nil
}

// CaptureReleaseNewWindow ends the hold of a new window and shows a held window.
func (implementation) CaptureReleaseNewWindow() { diagnosticNative.ReleaseCaptureNewWindow() }

// CaptureEndWait ends the wait of the capture call of token from any thread.
func (implementation) CaptureEndWait(token uint64, reason string) {
	text := native.CString(reason)
	defer native.Free(unsafe.Pointer(text))
	diagnosticNative.EndCaptureWait(token, text)
}

func (implementation) CaptureMissed() int { return int(diagnosticNative.SpCaptureMissed()) }

func (implementation) CaptureLate() int { return int(diagnosticNative.SpCaptureLate()) }

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
// committed, requested, commit path code, open at commit and flushed. A code that the native code does not declare is an error.
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
			CommitPath: path, OpenAtCommit: value[6], Flushed: value[7],
		}
	}
	return records, nil
}

func (implementation) CaptureStill(windowNumber int, path string) error {
	if strings.IndexByte(path, 0) >= 0 {
		return errors.New("still capture: path contains NUL")
	}
	target := native.CString(path)
	defer native.Free(unsafe.Pointer(target))
	answer := awaitCaptureAnswer(func(context uintptr) {
		diagnosticNative.ScheduleCaptureStill(int64(windowNumber), target, context)
	})
	return captureAnswerError("still", answer)
}
