//go:build windows

package windows

import (
	"errors"
	"fmt"
	"os"
	"unsafe"
)

// stillEnds holds the ends of the still captures that wait (captureWait).
var stillEnds captureEnds

// endStill ends the wait of the still capture of token with reason.
func endStill(token uint64, reason string) { stillEnds.end(token, reason) }

// captureStill writes one picture of the web view of the window to path as PNG, through CapturePreview. It needs no prompt, no foreground
// and no real input. The wait runs on the caller's thread, and the completion on the UI thread, so a call on the UI thread would wait for itself.
func captureStill(window uintptr, path string, token uint64) error {
	if onUIThread() {
		return errors.New("capture: a capture waits for the UI thread, and it was called on that thread")
	}
	type picture struct {
		data []byte
		err  error
	}
	ended := make(chan picture, 1)
	answer, end := captureWait(func(data []byte, err error) { ended <- picture{data, err} })
	defer stillEnds.wait(token, end)()
	if err := post(func() {
		if err := startCapture(window, answer); err != nil {
			answer(nil, err)
		}
	}); err != nil {
		return fmt.Errorf("capture: %w", err)
	}
	got := <-ended
	if got.err != nil {
		return got.err
	}
	if err := checkStill(got.data); err != nil {
		return err
	}
	return os.WriteFile(path, got.data, 0o600)
}

// startCapture starts CapturePreview on the UI thread. It returns why it did not start, and otherwise done receives its completion.
func startCapture(window uintptr, done func([]byte, error)) error {
	view, err := webviewOf(window)
	if err != nil {
		return err
	}
	// default: IsIconic sets no error that GetLastError reads, so its value is the whole answer and the error of Call holds nothing.
	minimized, _, _ := procIsIconic.Call(view.window)
	// default: IsWindowVisible sets no error that GetLastError reads, so its value is the whole answer and the error of Call holds nothing.
	shown, _, _ := procIsWindowVisible.Call(view.window)
	var visible int32
	if result := comCall(view.controller, controllerGetIsVisible, uintptr(unsafe.Pointer(&visible))); failedResult(result) {
		return resultError("capture: web view visibility", result)
	}
	if err := captureRefusal(minimized != 0, shown != 0, visible != 0); err != nil {
		return err
	}
	var stream uintptr
	// default: CreateStreamOnHGlobal reports its failure in the HRESULT that this line checks, not through GetLastError.
	if result, _, _ := procCreateStreamOnHGlobal.Call(0, 1, uintptr(unsafe.Pointer(&stream))); failedResult(result) {
		return resultError("capture: stream", result)
	}
	handler := newHandler(handlerVtables().plain, func(result, _ uintptr) {
		defer comCall(stream, slotRelease)
		if failedResult(result) {
			done(nil, resultError("capture: CapturePreview", result))
			return
		}
		done(streamBytes(stream))
	})
	defer comCall(handler, slotRelease)
	// COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG is 0.
	if result := comCall(view.core, webviewCapturePreview, 0, stream, handler); failedResult(result) {
		comCall(stream, slotRelease)
		done(nil, resultError("capture: CapturePreview", result))
	}
	return nil
}

// streamBytes reads a whole stream.
func streamBytes(stream uintptr) ([]byte, error) {
	const seekSet, seekEnd = 0, 2
	var size uint64
	if result := comCall(stream, streamSeek, 0, seekEnd, uintptr(unsafe.Pointer(&size))); failedResult(result) {
		return nil, resultError("capture: stream size", result)
	}
	if result := comCall(stream, streamSeek, 0, seekSet, 0); failedResult(result) {
		return nil, resultError("capture: stream start", result)
	}
	data := make([]byte, size)
	if size == 0 {
		return data, nil
	}
	var read uint32
	if result := comCall(stream, streamRead, uintptr(unsafe.Pointer(&data[0])), uintptr(size), uintptr(unsafe.Pointer(&read))); failedResult(result) {
		return nil, resultError("capture: stream read", result)
	}
	return data[:read], nil
}
