//go:build darwin && diagnostics

package darwin

// Reads and selects the keyboard input source. The implementation is input_source.m of native/darwin, which also holds the input
// source of each role. It is included only in diagnostic builds.

import (
	"errors"
	"fmt"

	"strings"
	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
)

// InputSource returns the role of the currently selected keyboard input source, "" for an input source without a role, and its
// identifier. Call it in a main-thread step.
func (implementation) InputSource() (string, string, error) {
	pointer := diagnosticNative.MainSpInputSourceCurrent()
	if pointer == nil {
		return "", "", errors.New("the selected keyboard input source could not be read")
	}
	defer native.Free(unsafe.Pointer(pointer))
	role := diagnosticNative.InputSourceIdentifierRole(pointer)
	if role == nil {
		return "", native.GoString(pointer), nil
	}
	return native.GoString(role), native.GoString(pointer), nil
}

// SelectInputSource selects the input source of role and waits for active key-view context adoption. Call it in a main-thread step.
func (implementation) SelectInputSource(role string, adopted func(error)) (end func(reason string)) {
	if adopted == nil {
		panic("input source selection requires an adoption callback")
	}
	if strings.IndexByte(role, 0) >= 0 {
		adopted(errors.New("input source role contains NUL"))
		return func(string) {}
	}
	wanted := native.CString(role)
	defer native.Free(unsafe.Pointer(wanted))
	identifier := diagnosticNative.InputSourceRoleIdentifier(wanted)
	if identifier == nil {
		adopted(fmt.Errorf("the input source role %q has no input source on macOS", role))
		return func(string) {}
	}
	return selectAndAwait(identifier, adopted)
}

// selectAndAwait selects the input source identifier and returns the end of its wait.
func selectAndAwait(identifier *byte, adopted func(error)) (end func(reason string)) {
	handle := uintptr(handles.NewHandle(adopted))
	diagnosticNative.InputSourceSelectAndAwait(identifier, handle)
	return func(reason string) {
		text := native.CString(reason)
		defer native.Free(unsafe.Pointer(text))
		diagnosticNative.EndInputSourceSelection(handle, text)
	}
}

// RestoreInputSource selects the input source with identifier source and waits for active key-view context adoption. Call it in a
// main-thread step.
func (implementation) RestoreInputSource(source string, adopted func(error)) (end func(reason string)) {
	if adopted == nil {
		panic("input source selection requires an adoption callback")
	}
	if strings.IndexByte(source, 0) >= 0 {
		adopted(errors.New("input source identifier contains NUL"))
		return func(string) {}
	}
	wanted := native.CString(source)
	defer native.Free(unsafe.Pointer(wanted))
	return selectAndAwait(wanted, adopted)
}

func goHost_native_input_source_adopted(value uintptr, failure *byte) {
	handle := handles.Handle(value)
	adopted := handle.Value().(func(error))
	handle.Delete()
	if failure == nil {
		adopted(nil)
		return
	}
	adopted(errors.New(native.GoString(failure)))
}
