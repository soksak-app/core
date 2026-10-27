//go:build darwin && diagnostics

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules -DSOKSAK_DIAGNOSTIC
#cgo LDFLAGS: -framework Cocoa
#cgo pkg-config: soksak-darwin
#include <stdint.h>
#include <stdlib.h>
#include "document_view.h"

extern void documentFrameIdentityDone(uintptr_t context, char *json, char *error);

static void documentFrameIdentityDoneBridge(void *context, const char *json, const char *error) {
	documentFrameIdentityDone((uintptr_t)context, (char *)json, (char *)error);
}

static bool scheduleDocumentFrameIdentityStart(void *document, uint64_t generation, uintptr_t context) {
	return sp_document_frame_identity_start(document, generation, documentFrameIdentityDoneBridge, (void *)context);
}

static bool scheduleDocumentFrameIdentityFreeze(uint64_t generation, uintptr_t context) {
	return sp_document_frame_identity_freeze(generation, documentFrameIdentityDoneBridge, (void *)context);
}

static bool scheduleDocumentFrameIdentityRemove(uint64_t generation, uintptr_t context) {
	return sp_document_frame_identity_remove(generation, documentFrameIdentityDoneBridge, (void *)context);
}
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime/cgo"
	"unsafe"
)

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

//export documentFrameIdentityDone
func documentFrameIdentityDone(context C.uintptr_t, reply *C.char, nativeError *C.char) {
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
