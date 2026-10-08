//go:build darwin

package darwin

// 표면 문서 안의 외부 문서 웹뷰. 구현은 native/darwin 의 document_view.m 이다.

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "document_view.h"

extern void documentChanged(void *context, char *state);
extern void documentEvent(void *context, char *event);
extern void documentMessage(void *context, char *message);

static void documentChangedBridge(void *context, const char *state) {
    documentChanged(context, (char *)state);
}
static void documentEventBridge(void *context, const char *event) {
    documentEvent(context, (char *)event);
}

static void documentMessageBridge(void *context, const char *message) {
    documentMessage(context, (char *)message);
}

static void *documentCreate(void *surface, const char *store, const char *package, const char *plugin, uintptr_t context) {
    return sp_document_create(surface, store, package, plugin, documentChangedBridge, (void *)context);
}
static void documentSetMessage(void *document, uintptr_t context) {
    sp_document_set_message(document, documentMessageBridge, (void *)context);
}
static void documentSetEvent(void *document, uintptr_t context) {
    sp_document_set_event(document, documentEventBridge, (void *)context);
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
var documentEvents = map[unsafe.Pointer]cgo.Handle{}
var documentMessages = map[unsafe.Pointer]cgo.Handle{}

//export documentChanged
func documentChanged(context unsafe.Pointer, state *C.char) {
	changed := cgo.Handle(uintptr(context)).Value().(func(string))
	changed(C.GoString(state))
}

//export documentMessage
func documentMessage(context unsafe.Pointer, value *C.char) {
	cgo.Handle(uintptr(context)).Value().(func(string))(C.GoString(value))
}

//export documentEvent
func documentEvent(context unsafe.Pointer, value *C.char) {
	cgo.Handle(uintptr(context)).Value().(func(string))(C.GoString(value))
}

func (implementation) CreateDocument(surface unsafe.Pointer, directory, folder, plugin string, changed func(state string)) (unsafe.Pointer, error) {
	name := C.CString(directory)
	defer C.free(unsafe.Pointer(name))
	folderText := C.CString(folder)
	defer C.free(unsafe.Pointer(folderText))
	id := C.CString(plugin)
	defer C.free(unsafe.Pointer(id))
	receiver := cgo.NewHandle(changed)
	document := C.documentCreate(surface, name, folderText, id, C.uintptr_t(receiver))
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

func (implementation) ZoomDocument(document unsafe.Pointer, zoom float64) bool {
	return bool(C.sp_document_zoom(document, C.double(zoom)))
}

func (implementation) SetDocumentEvent(document unsafe.Pointer, event func(value string)) error {
	receiver := cgo.NewHandle(event)
	C.documentSetEvent(document, C.uintptr_t(receiver))
	documentEvents[document] = receiver
	return nil
}

func (implementation) SetDocumentMessage(document unsafe.Pointer, message func(value string)) error {
	receiver := cgo.NewHandle(message)
	C.documentSetMessage(document, C.uintptr_t(receiver))
	documentMessages[document] = receiver
	return nil
}

func (implementation) PostDocument(document unsafe.Pointer, json string) bool {
	value := C.CString(json)
	defer C.free(unsafe.Pointer(value))
	return bool(C.sp_document_post(document, value))
}

func (implementation) GoDocument(document unsafe.Pointer, action, offset int) bool {
	return bool(C.sp_document_go(document, C.int(action), C.int(offset)))
}

func (implementation) PlaceDocument(document unsafe.Pointer, left, top, right, bottom float64, visible bool) {
	C.sp_document_place(document, C.double(left), C.double(top), C.double(right), C.double(bottom), C.bool(visible))
}

func (implementation) SetDocumentBackground(document unsafe.Pointer, enabled bool) {
	C.sp_document_background(document, C.bool(enabled))
}

func (implementation) SetDocumentAppearance(document unsafe.Pointer, dark bool) {
	C.sp_document_appearance(document, C.bool(dark))
}

func (implementation) CloseDocument(document unsafe.Pointer) {
	C.sp_document_close(document)
	if receiver, ok := documents[document]; ok {
		receiver.Delete()
		delete(documents, document)
	}
	if receiver, ok := documentEvents[document]; ok {
		receiver.Delete()
		delete(documentEvents, document)
	}
	if receiver, ok := documentMessages[document]; ok {
		receiver.Delete()
		delete(documentMessages, document)
	}
}
