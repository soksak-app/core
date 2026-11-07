//go:build darwin && diagnostics

package darwin

/*
#include <stdint.h>
#include <stdlib.h>
#include "input_reference.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native call runs on the main thread (main_thread.h).
static void referenceReply(void *context, const char *reply, const char *failure) {
    hostRunOnWorker(^{ sp_host_diagnostic_callback_input_reference_reply((uintptr_t)context, (char *)reply, (char *)failure); });
}
static void inputReference(uintptr_t window, const char *action, const char *document, uintptr_t context) {
    hostRunOnMain(^{ sp_input_reference((void *)window, action, document, referenceReply, (void *)context); });
}
*/
import "C"

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
	operation := C.CString(action)
	defer C.free(unsafe.Pointer(operation))
	var expected *C.char
	if document != nil {
		expected = C.CString(*document)
		defer C.free(unsafe.Pointer(expected))
	}
	C.inputReference(C.uintptr_t(window), operation, expected, C.uintptr_t(handles.NewHandle(done)))
}

//export goHost_input_reference_reply
func goHost_input_reference_reply(context C.uintptr_t, value, failure *C.char) {
	handle := handles.Handle(context)
	done := handle.Value().(func(json.RawMessage, error))
	handle.Delete()
	if failure != nil {
		done(nil, errors.New(C.GoString(failure)))
		return
	}
	reply := json.RawMessage(C.GoString(value))
	if !json.Valid(reply) {
		done(nil, errors.New("input reference returned invalid JSON"))
		return
	}
	done(reply, nil)
}
