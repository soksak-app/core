//go:build darwin

package darwin

// The external document web view inside a surface document. The implementation is document_view.m of native/darwin.

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "document_view.h"

extern void documentChanged(void *context, char *state);
extern void documentEvent(void *context, char *event);
extern void documentMessage(void *context, char *message);
extern void documentStream(void *context, char *message);
extern void documentQueried(void *context, char *reply);

static void documentChangedBridge(void *context, const char *state) {
    documentChanged(context, (char *)state);
}
static void documentEventBridge(void *context, const char *event) {
    documentEvent(context, (char *)event);
}

static void documentMessageBridge(void *context, const char *message) {
    documentMessage(context, (char *)message);
}

static void documentStreamBridge(void *context, const char *message) {
    documentStream(context, (char *)message);
}

static void documentQueriedBridge(void *context, const char *reply) {
    documentQueried(context, (char *)reply);
}

static void documentQuery(void *document, uintptr_t context) {
    sp_document_query(document, documentQueriedBridge, (void *)context);
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
static void documentSetStream(void *document, uintptr_t context) {
    sp_document_set_stream(document, documentStreamBridge, (void *)context);
}
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"unsafe"
)

// documents are the state receiver handles of each document handle. They are read and changed only on the UI thread.
var documents = map[unsafe.Pointer]cgo.Handle{}
var documentEvents = map[unsafe.Pointer]cgo.Handle{}
var documentMessages = map[unsafe.Pointer]cgo.Handle{}
var documentStreams = map[unsafe.Pointer]cgo.Handle{}

//export documentChanged
func documentChanged(context unsafe.Pointer, state *C.char) {
	changed := cgo.Handle(uintptr(context)).Value().(func(string))
	changed(C.GoString(state))
}

//export documentMessage
func documentMessage(context unsafe.Pointer, value *C.char) {
	cgo.Handle(uintptr(context)).Value().(func(string))(C.GoString(value))
}

//export documentStream
func documentStream(context unsafe.Pointer, value *C.char) {
	cgo.Handle(uintptr(context)).Value().(func(string))(C.GoString(value))
}

// documentQueried receives the one reply of a query and releases its receiver.
//
//export documentQueried
func documentQueried(context unsafe.Pointer, value *C.char) {
	handle := cgo.Handle(uintptr(context))
	reply := handle.Value().(func(string))
	handle.Delete()
	reply(C.GoString(value))
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

func (implementation) SetDocumentStream(document unsafe.Pointer, stream func(value string)) error {
	receiver := cgo.NewHandle(stream)
	C.documentSetStream(document, C.uintptr_t(receiver))
	documentStreams[document] = receiver
	return nil
}

func (implementation) SetDocumentStreamOn(document unsafe.Pointer, stream string, on bool) bool {
	name := C.CString(stream)
	defer C.free(unsafe.Pointer(name))
	return bool(C.sp_document_stream_on(document, name, C.bool(on)))
}

func (implementation) AckDocumentStream(document unsafe.Pointer, seq uint64) bool {
	return bool(C.sp_document_stream_ack(document, C.ulonglong(seq)))
}

func (implementation) PostDocument(document unsafe.Pointer, json string) bool {
	value := C.CString(json)
	defer C.free(unsafe.Pointer(value))
	return bool(C.sp_document_post(document, value))
}

func (implementation) GoDocument(document unsafe.Pointer, action, offset int) bool {
	return bool(C.sp_document_go(document, C.int(action), C.int(offset)))
}

func (implementation) QueryDocument(document unsafe.Pointer, reply func(value string)) {
	C.documentQuery(document, C.uintptr_t(cgo.NewHandle(reply)))
}

func (implementation) DocumentInteractionState(document unsafe.Pointer) (string, bool) {
	state := C.sp_document_interaction_state(document)
	if state == nil {
		return "", false
	}
	defer C.free(unsafe.Pointer(state))
	return C.GoString(state), true
}

func (implementation) RestoreDocument(document unsafe.Pointer, state string) error {
	value := C.CString(state)
	defer C.free(unsafe.Pointer(value))
	if refusal := C.sp_document_restore(document, value); refusal != nil {
		return errors.New(C.GoString(refusal))
	}
	return nil
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
	if receiver, ok := documentStreams[document]; ok {
		receiver.Delete()
		delete(documentStreams, document)
	}
}
