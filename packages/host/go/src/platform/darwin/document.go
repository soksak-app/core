//go:build darwin

package darwin

// The external document web view inside a surface document. The implementation is document_view.m of native/darwin.

import (
	"errors"
	"fmt"

	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// documents are the state receiver handles of each document handle. They are read and changed only in main-thread steps.
var documents = map[unsafe.Pointer]handles.Handle{}
var documentEvents = map[unsafe.Pointer]handles.Handle{}
var documentMessages = map[unsafe.Pointer]handles.Handle{}

// viewMessages holds the receiver of each view document until the document closes, as documentMessages does for regions.
var viewMessages = map[unsafe.Pointer]handles.Handle{}

// viewEnds holds the receiver of the end of each view until the view closes.
var viewEnds = map[unsafe.Pointer]handles.Handle{}

// viewResponsivenesses holds the receiver of the responsiveness notices of each view until the view closes.
var viewResponsivenesses = map[unsafe.Pointer]handles.Handle{}
var documentStreams = map[unsafe.Pointer]handles.Handle{}

func goHost_document_changed(context uintptr, state *byte) {
	changed := handles.Handle(uintptr(context)).Value().(func(string))
	changed(native.GoString(state))
}

func goHost_document_message(context uintptr, value *byte) {
	handles.Handle(uintptr(context)).Value().(func(string))(native.GoString(value))
}

func goHost_view_message(context uintptr, value *byte) {
	handles.Handle(uintptr(context)).Value().(func(string))(native.GoString(value))
}

func goHost_view_ended(context uintptr) {
	handles.Handle(uintptr(context)).Value().(func())()
}

func goHost_view_responsiveness(context uintptr, responsive bool) {
	handles.Handle(uintptr(context)).Value().(func(bool))(bool(responsive))
}

func goHost_document_stream(context uintptr, value *byte) {
	handles.Handle(uintptr(context)).Value().(func(string))(native.GoString(value))
}

// coreRootSet and coreRootHandle hold the core root resolver of the application, which is registered once at its start.
var coreRootSet bool
var coreRootHandle handles.Handle

// goHost_core_root_serve answers one request of the core root of a view with the resolver that SetCoreRoot registered. It returns false
// for a path that the resolver does not serve. The file is copied into a core root buffer (coreRootBufferCreate), which the native
// scheme releases page by page while it sends the file. A buffer that is not allocated is written to the application log by the
// native side, and the request is not found.
func goHost_core_root_serve(context uintptr, plugin, urlPath *byte, bytes *unsafe.Pointer, length *uint64, contentType **byte) bool {
	resolve := handles.Handle(uintptr(context)).Value().(platform.CoreRootResolver)
	data, kind, found := resolve(native.GoString(plugin), native.GoString(urlPath))
	if !found {
		return false
	}
	buffer := native.CoreRootBufferCreate(uint64(len(data)))
	if buffer == nil {
		return false
	}
	copy(unsafe.Slice((*byte)(buffer), len(data)), data)
	*bytes = buffer
	*length = uint64(len(data))
	*contentType = native.CString(kind)
	return true
}

// goHost_document_queried receives the one reply of a query and releases its receiver.
func goHost_document_queried(context uintptr, value *byte) {
	handle := handles.Handle(uintptr(context))
	reply := handle.Value().(func(string))
	handle.Delete()
	reply(native.GoString(value))
}

func goHost_document_event(context uintptr, value *byte) {
	handles.Handle(uintptr(context)).Value().(func(string))(native.GoString(value))
}

// SetCoreRoot registers the resolver of the core root. The application registers one resolver at its start, and a second
// registration is refused, so the handle of the first one is kept for the process.
func (implementation) SetCoreRoot(resolve platform.CoreRootResolver) error {
	if coreRootSet {
		return errors.New("the core root resolver is already set")
	}
	coreRootSet = true
	coreRootHandle = handles.NewHandle(resolve)
	native.CoreRootSet(uintptr(coreRootHandle))
	return nil
}

// SetViewImportMap sets the view import map of the native view handler. The handler copies the text.
func (implementation) SetViewImportMap(text string) error {
	cText := native.CString(text)
	defer native.Free(unsafe.Pointer(cText))
	native.MainSpViewImportMapSet(cText)
	return nil
}

func (implementation) CreateDocument(surface unsafe.Pointer, options platform.DocumentOptions, changed func(state string)) (unsafe.Pointer, error) {
	name := native.CString(options.Directory)
	defer native.Free(unsafe.Pointer(name))
	folderText := native.CString(options.Folder)
	defer native.Free(unsafe.Pointer(folderText))
	id := native.CString(options.Plugin)
	defer native.Free(unsafe.Pointer(id))
	labelText := native.CString(options.Label)
	defer native.Free(unsafe.Pointer(labelText))
	// A region has no channel script, so its channel is NULL; a view configuration has the script text.
	var channelText *byte
	if options.Channel != "" {
		channelText = native.CString(options.Channel)
		defer native.Free(unsafe.Pointer(channelText))
	}
	receiver := handles.NewHandle(changed)
	document := native.DocumentCreate(surface, name, folderText, id, labelText, channelText, uintptr(receiver))
	if document == nil {
		receiver.Delete()
		return nil, creationError("cannot create a document view in this surface", native.GoString(native.MainSpDocumentLastError()))
	}
	documents[document] = receiver
	return document, nil
}

// failNextCreation makes the next creation of a document region or view web view fail with cause in the native layer. The
// owning unit tests call it.
func failNextCreation(cause string) {
	text := native.CString(cause)
	defer native.Free(unsafe.Pointer(text))
	native.MainSpDocumentFailCreationForTest(text)
}

// creationError is the error of a native creation that returned no handle, followed by the native cause. Every failure of the
// native creation states its cause, so an empty cause is reported as missing rather than left out.
func creationError(message, cause string) error {
	if cause == "" {
		cause = missingNativeCause
	}
	return fmt.Errorf("%s: %s", message, cause)
}

// missingNativeCause is the cause that an error states when the native layer failed a creation without a cause.
const missingNativeCause = "the native layer stated no cause"

func (implementation) LoadDocument(document unsafe.Pointer, url string) bool {
	address := native.CString(url)
	defer native.Free(unsafe.Pointer(address))
	return bool(native.MainSpDocumentLoad(document, address))
}

func (implementation) ZoomDocument(document unsafe.Pointer, zoom float64) bool {
	return bool(native.MainSpDocumentZoom(document, float64(zoom)))
}

func (implementation) SetViewMessage(document unsafe.Pointer, message func(value string)) error {
	receiver := handles.NewHandle(message)
	native.DocumentSetViewMessage(document, uintptr(receiver))
	viewMessages[document] = receiver
	return nil
}

func (implementation) SetViewEnded(document unsafe.Pointer, ended func()) error {
	receiver := handles.NewHandle(ended)
	native.DocumentSetViewEnded(document, uintptr(receiver))
	viewEnds[document] = receiver
	return nil
}

func (implementation) SetViewResponsiveness(document unsafe.Pointer, responsiveness func(responsive bool)) error {
	receiver := handles.NewHandle(responsiveness)
	native.DocumentSetViewResponsiveness(document, uintptr(receiver))
	viewResponsivenesses[document] = receiver
	return nil
}

func (implementation) TakeDocumentBinary(document unsafe.Pointer, id string) ([]byte, error) {
	cID := native.CString(id)
	defer native.Free(unsafe.Pointer(cID))
	var bytes unsafe.Pointer
	var length uint64
	if text := native.DocumentBinaryTake(document, cID, &bytes, &length); text != nil {
		return nil, errors.New(native.GoString(text))
	}
	defer native.Free(bytes)
	return native.GoBytes(bytes, int32(length)), nil
}

func (implementation) PutDocumentBinary(document unsafe.Pointer, bytes []byte, contentType string) (string, error) {
	cType := native.CString(contentType)
	defer native.Free(unsafe.Pointer(cType))
	var cBytes unsafe.Pointer
	if len(bytes) > 0 {
		cBytes = native.CBytes(bytes)
		defer native.Free(cBytes)
	}
	id := (*byte)(native.Calloc(33, 1))
	defer native.Free(unsafe.Pointer(id))
	if text := native.DocumentBinaryPut(document, cBytes, uint64(len(bytes)), cType, id); text != nil {
		defer native.Free(unsafe.Pointer(text))
		return "", errors.New(native.GoString(text))
	}
	return native.GoString(id), nil
}

func (implementation) AddDocumentScript(document unsafe.Pointer, source string) error {
	cSource := native.CString(source)
	defer native.Free(unsafe.Pointer(cSource))
	native.DocumentAddScript(document, cSource)
	return nil
}

func (implementation) SetDocumentEvent(document unsafe.Pointer, event func(value string)) error {
	receiver := handles.NewHandle(event)
	native.DocumentSetEvent(document, uintptr(receiver))
	documentEvents[document] = receiver
	return nil
}

func (implementation) SetDocumentMessage(document unsafe.Pointer, message func(value string)) error {
	receiver := handles.NewHandle(message)
	native.DocumentSetMessage(document, uintptr(receiver))
	documentMessages[document] = receiver
	return nil
}

func (implementation) SetDocumentStream(document unsafe.Pointer, stream func(value string)) error {
	receiver := handles.NewHandle(stream)
	native.DocumentSetStream(document, uintptr(receiver))
	documentStreams[document] = receiver
	return nil
}

func (implementation) SetDocumentStreamOn(document unsafe.Pointer, stream string, on bool) bool {
	name := native.CString(stream)
	defer native.Free(unsafe.Pointer(name))
	return bool(native.MainSpDocumentStreamOn(document, name, bool(on)))
}

func (implementation) AckDocumentStream(document unsafe.Pointer, seq uint64) bool {
	return bool(native.MainSpDocumentStreamAck(document, uint64(seq)))
}

func (implementation) PostDocument(document unsafe.Pointer, json string) bool {
	value := native.CString(json)
	defer native.Free(unsafe.Pointer(value))
	return bool(native.MainSpDocumentPost(document, value))
}

func (implementation) GoDocument(document unsafe.Pointer, action, offset int) bool {
	return bool(native.MainSpDocumentGo(document, int32(action), int32(offset)))
}

func (implementation) QueryDocument(document unsafe.Pointer, reply func(value string)) {
	native.DocumentQuery(document, uintptr(handles.NewHandle(reply)))
}

func (implementation) DocumentInteractionState(document unsafe.Pointer) (string, bool) {
	state := native.MainSpDocumentInteractionState(document)
	if state == nil {
		return "", false
	}
	defer native.Free(unsafe.Pointer(state))
	return native.GoString(state), true
}

func (implementation) RestoreDocument(document unsafe.Pointer, state string) error {
	value := native.CString(state)
	defer native.Free(unsafe.Pointer(value))
	if refusal := native.MainSpDocumentRestore(document, value); refusal != nil {
		return errors.New(native.GoString(refusal))
	}
	return nil
}

func (implementation) PlaceDocument(document unsafe.Pointer, left, top, right, bottom float64, visible bool) {
	native.MainSpDocumentPlace(document, float64(left), float64(top), float64(right), float64(bottom), bool(visible))
}

func (implementation) SetDocumentBackground(document unsafe.Pointer, enabled bool) {
	native.MainSpDocumentBackground(document, bool(enabled))
}

func (implementation) SetDocumentAppearance(document unsafe.Pointer, dark bool) {
	native.MainSpDocumentAppearance(document, bool(dark))
}

func (implementation) CloseDocument(document unsafe.Pointer) {
	native.MainSpDocumentClose(document)
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
