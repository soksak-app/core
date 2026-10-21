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
extern void viewMessage(void *context, char *message);
extern void viewEnded(void *context);
extern void viewResponsiveness(void *context, bool responsive);
extern void documentStream(void *context, char *message);
extern void documentQueried(void *context, char *reply);
extern bool coreRootServe(void *context, char *plugin, char *path, void **bytes, size_t *length, char **contentType);

static bool coreRootBridge(void *context, const char *plugin, const char *path, void **bytes, size_t *length, char **type) {
    return coreRootServe(context, (char *)plugin, (char *)path, bytes, length, type);
}

static void coreRootSet(uintptr_t context) {
    sp_core_root_set_resolver(coreRootBridge, (void *)context);
}

static void documentChangedBridge(void *context, const char *state) {
    documentChanged(context, (char *)state);
}
static void documentEventBridge(void *context, const char *event) {
    documentEvent(context, (char *)event);
}

static void documentMessageBridge(void *context, const char *message) {
    documentMessage(context, (char *)message);
}

static void viewMessageBridge(void *context, const char *message) {
    viewMessage(context, (char *)message);
}

static void viewEndedBridge(void *context) {
    viewEnded(context);
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

static void *documentCreate(void *surface, const char *store, const char *package, const char *plugin, const char *channel, uintptr_t context) {
    return sp_document_create(surface, store, package, plugin, channel, documentChangedBridge, (void *)context);
}
static void *pluginHostCreate(void *window, const char *store, const char *package, const char *plugin, const char *channel, uintptr_t context) {
    return sp_plugin_host_create(window, store, package, plugin, channel, documentChangedBridge, (void *)context);
}
static void documentSetMessage(void *document, uintptr_t context) {
    sp_document_set_message(document, documentMessageBridge, (void *)context);
}
static void documentSetViewMessage(void *document, uintptr_t context) {
    sp_document_set_view_message(document, viewMessageBridge, (void *)context);
}
static void documentSetViewEnded(void *document, uintptr_t context) {
    sp_document_set_view_ended(document, viewEndedBridge, (void *)context);
}
static void viewResponsivenessBridge(void *context, bool responsive) {
    viewResponsiveness(context, responsive);
}
static const char *documentBinaryTake(void *document, const char *id, void **bytes, size_t *length) {
    return sp_document_binary_take(document, id, bytes, length);
}
static void documentAddScript(void *document, const char *source) {
    sp_document_add_user_script(document, source);
}
static void documentSetViewResponsiveness(void *document, uintptr_t context) {
    sp_document_set_view_responsiveness(document, viewResponsivenessBridge, (void *)context);
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

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// documents are the state receiver handles of each document handle. They are read and changed only on the UI thread.
var documents = map[unsafe.Pointer]cgo.Handle{}
var documentEvents = map[unsafe.Pointer]cgo.Handle{}
var documentMessages = map[unsafe.Pointer]cgo.Handle{}

// viewMessages holds the receiver of each view document until the document closes, as documentMessages does for regions.
var viewMessages = map[unsafe.Pointer]cgo.Handle{}

// viewEnds holds the receiver of the end of each view until the view closes.
var viewEnds = map[unsafe.Pointer]cgo.Handle{}

// viewResponsivenesses holds the receiver of the responsiveness notices of each view until the view closes.
var viewResponsivenesses = map[unsafe.Pointer]cgo.Handle{}
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

//export viewMessage
func viewMessage(context unsafe.Pointer, value *C.char) {
	cgo.Handle(uintptr(context)).Value().(func(string))(C.GoString(value))
}

//export viewEnded
func viewEnded(context unsafe.Pointer) {
	cgo.Handle(uintptr(context)).Value().(func())()
}

//export viewResponsiveness
func viewResponsiveness(context unsafe.Pointer, responsive C.bool) {
	cgo.Handle(uintptr(context)).Value().(func(bool))(bool(responsive))
}

//export documentStream
func documentStream(context unsafe.Pointer, value *C.char) {
	cgo.Handle(uintptr(context)).Value().(func(string))(C.GoString(value))
}

// coreRootSet and coreRootHandle hold the core root resolver of the application, which is registered once at its start.
var coreRootSet bool
var coreRootHandle cgo.Handle

// coreRootServe answers one request of the core root of a view with the resolver that SetCoreRoot registered. It returns false
// for a path that the resolver does not serve. The file is copied to memory that the native scheme releases.
//
//export coreRootServe
func coreRootServe(context unsafe.Pointer, plugin, urlPath *C.char, bytes *unsafe.Pointer, length *C.size_t, contentType **C.char) C.bool {
	resolve := cgo.Handle(uintptr(context)).Value().(platform.CoreRootResolver)
	data, kind, found := resolve(C.GoString(plugin), C.GoString(urlPath))
	if !found {
		return false
	}
	*bytes = C.CBytes(data)
	*length = C.size_t(len(data))
	*contentType = C.CString(kind)
	return true
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

// SetCoreRoot registers the resolver of the core root. The application registers one resolver at its start, and a second
// registration is refused, so the handle of the first one is kept for the process.
func (implementation) SetCoreRoot(resolve platform.CoreRootResolver) error {
	if coreRootSet {
		return errors.New("the core root resolver is already set")
	}
	coreRootSet = true
	coreRootHandle = cgo.NewHandle(resolve)
	C.coreRootSet(C.uintptr_t(coreRootHandle))
	return nil
}

func (implementation) CreateDocument(surface unsafe.Pointer, directory, folder, plugin, channel string, changed func(state string)) (unsafe.Pointer, error) {
	name := C.CString(directory)
	defer C.free(unsafe.Pointer(name))
	folderText := C.CString(folder)
	defer C.free(unsafe.Pointer(folderText))
	id := C.CString(plugin)
	defer C.free(unsafe.Pointer(id))
	// A region has no channel script, so its channel is NULL; a view configuration has the script text.
	var channelText *C.char
	if channel != "" {
		channelText = C.CString(channel)
		defer C.free(unsafe.Pointer(channelText))
	}
	receiver := cgo.NewHandle(changed)
	document := C.documentCreate(surface, name, folderText, id, channelText, C.uintptr_t(receiver))
	if document == nil {
		receiver.Delete()
		return nil, errors.New("cannot create a document view in this surface")
	}
	documents[document] = receiver
	return document, nil
}

// CreatePluginHost creates the plugin host web view of a plugin hidden in the window itself with the view configuration
// (docs/spec/plugin-host.md). The state receiver is kept until CloseDocument, as the receiver of a document region is.
func (implementation) CreatePluginHost(window unsafe.Pointer, directory, folder, plugin, channel string, changed func(state string)) (unsafe.Pointer, error) {
	name := C.CString(directory)
	defer C.free(unsafe.Pointer(name))
	folderText := C.CString(folder)
	defer C.free(unsafe.Pointer(folderText))
	id := C.CString(plugin)
	defer C.free(unsafe.Pointer(id))
	channelText := C.CString(channel)
	defer C.free(unsafe.Pointer(channelText))
	receiver := cgo.NewHandle(changed)
	document := C.pluginHostCreate(window, name, folderText, id, channelText, C.uintptr_t(receiver))
	if document == nil {
		receiver.Delete()
		return nil, errors.New("cannot create a plugin host web view in this window")
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

func (implementation) SetViewMessage(document unsafe.Pointer, message func(value string)) error {
	receiver := cgo.NewHandle(message)
	C.documentSetViewMessage(document, C.uintptr_t(receiver))
	viewMessages[document] = receiver
	return nil
}

func (implementation) SetViewEnded(document unsafe.Pointer, ended func()) error {
	receiver := cgo.NewHandle(ended)
	C.documentSetViewEnded(document, C.uintptr_t(receiver))
	viewEnds[document] = receiver
	return nil
}

func (implementation) SetViewResponsiveness(document unsafe.Pointer, responsiveness func(responsive bool)) error {
	receiver := cgo.NewHandle(responsiveness)
	C.documentSetViewResponsiveness(document, C.uintptr_t(receiver))
	viewResponsivenesses[document] = receiver
	return nil
}

func (implementation) TakeDocumentBinary(document unsafe.Pointer, id string) ([]byte, error) {
	cID := C.CString(id)
	defer C.free(unsafe.Pointer(cID))
	var bytes unsafe.Pointer
	var length C.size_t
	if text := C.documentBinaryTake(document, cID, &bytes, &length); text != nil {
		return nil, errors.New(C.GoString(text))
	}
	defer C.free(bytes)
	return C.GoBytes(bytes, C.int(length)), nil
}

func (implementation) AddDocumentScript(document unsafe.Pointer, source string) error {
	cSource := C.CString(source)
	defer C.free(unsafe.Pointer(cSource))
	C.documentAddScript(document, cSource)
	return nil
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
	if receiver, ok := viewMessages[document]; ok {
		receiver.Delete()
		delete(viewMessages, document)
	}
	if receiver, ok := viewEnds[document]; ok {
		receiver.Delete()
		delete(viewEnds, document)
	}
	if receiver, ok := viewResponsivenesses[document]; ok {
		receiver.Delete()
		delete(viewResponsivenesses, document)
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
