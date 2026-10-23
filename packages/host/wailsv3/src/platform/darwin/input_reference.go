//go:build darwin && diagnostics

package darwin

/*
#include <stdint.h>
#include <stdlib.h>
#include "input_reference.h"
extern void inputReferenceReply(uintptr_t context, char *reply, char *failure);
static void referenceReply(void *context, const char *reply, const char *failure) {
    inputReferenceReply((uintptr_t)context, (char *)reply, (char *)failure);
}
static void inputReference(void *window, const char *action, const char *document, uintptr_t context) {
    sp_input_reference(window, action, document, referenceReply, (void *)context);
}
*/
import "C"

import (
	"encoding/json"
	"errors"
	"runtime/cgo"
	"strings"
	"unsafe"
)

func (implementation) InputReference(window unsafe.Pointer, action string, document *string, done func(json.RawMessage, error)) {
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
	C.inputReference(window, operation, expected, C.uintptr_t(cgo.NewHandle(done)))
}

//export inputReferenceReply
func inputReferenceReply(context C.uintptr_t, value, failure *C.char) {
	handle := cgo.Handle(context)
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
