//go:build darwin && diagnostics

package darwin

import (
	"encoding/json"
	"errors"

	"strings"
	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

func (implementation) InputReference(window platform.Window, action string, document *string, done func(json.RawMessage, error)) {
	if strings.IndexByte(action, 0) >= 0 || (document != nil && strings.IndexByte(*document, 0) >= 0) {
		done(nil, errors.New("input reference action and document cannot contain NUL"))
		return
	}
	operation := native.CString(action)
	defer native.Free(unsafe.Pointer(operation))
	var expected *byte
	if document != nil {
		expected = native.CString(*document)
		defer native.Free(unsafe.Pointer(expected))
	}
	diagnosticNative.InputReference(uintptr(window), operation, expected, uintptr(handles.NewHandle(done)))
}

// EndInputReferenceWait ends the pending wait of the reference of window, naming reason in its failure. Call it in a main-thread step.
func (implementation) EndInputReferenceWait(window platform.Window, reason string) {
	text := native.CString(reason)
	defer native.Free(unsafe.Pointer(text))
	diagnosticNative.EndInputReferenceWait(uintptr(window), text)
}

func goHost_input_reference_reply(context uintptr, value, failure *byte) {
	handle := handles.Handle(context)
	done := handle.Value().(func(json.RawMessage, error))
	handle.Delete()
	if failure != nil {
		done(nil, errors.New(native.GoString(failure)))
		return
	}
	reply := json.RawMessage(native.GoString(value))
	if !json.Valid(reply) {
		done(nil, errors.New("input reference returned invalid JSON"))
		return
	}
	done(reply, nil)
}
