//go:build darwin

package darwin

// 표면 문서 안의 외부 문서 웹뷰. 구현은 native/darwin 의 document_view.m 이다.

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "document_view.h"

extern void documentChanged(void *context, char *state);

static void documentChangedBridge(void *context, const char *state) {
    documentChanged(context, (char *)state);
}

static void *documentCreate(void *surface, const char *store, uintptr_t context) {
    return sp_document_create(surface, store, documentChangedBridge, (void *)context);
}
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"unsafe"
)

// documents 는 문서 핸들별 상태 수신 핸들이다. UI 스레드에서만 읽고 바꾼다.
var documents = map[unsafe.Pointer]cgo.Handle{}

//export documentChanged
func documentChanged(context unsafe.Pointer, state *C.char) {
	changed := cgo.Handle(uintptr(context)).Value().(func(string))
	changed(C.GoString(state))
}

func (implementation) CreateDocument(surface unsafe.Pointer, store string, changed func(state string)) (unsafe.Pointer, error) {
	name := C.CString(store)
	defer C.free(unsafe.Pointer(name))
	receiver := cgo.NewHandle(changed)
	document := C.documentCreate(surface, name, C.uintptr_t(receiver))
	if document == nil {
		receiver.Delete()
		return nil, errors.New("cannot create a document view in this surface")
	}
	documents[document] = receiver
	return document, nil
}

func (implementation) LoadDocument(document unsafe.Pointer, url string) bool {
	address := C.CString(url)
	defer C.free(unsafe.Pointer(address))
	return bool(C.sp_document_load(document, address))
}

func (implementation) GoDocument(document unsafe.Pointer, action int) bool {
	return bool(C.sp_document_go(document, C.int(action)))
}

func (implementation) PlaceDocument(document unsafe.Pointer, left, top, right, bottom float64, visible bool) {
	C.sp_document_place(document, C.double(left), C.double(top), C.double(right), C.double(bottom), C.bool(visible))
}

func (implementation) SetDocumentBackground(document unsafe.Pointer, enabled bool) {
	C.sp_document_background(document, C.bool(enabled))
}

func (implementation) CloseDocument(document unsafe.Pointer) {
	C.sp_document_close(document)
	if receiver, ok := documents[document]; ok {
		receiver.Delete()
		delete(documents, document)
	}
}
