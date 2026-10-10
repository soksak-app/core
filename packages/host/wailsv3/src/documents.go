package host

// Document regions inside a surface page, as in the section Document regions of docs/spec/native-surfaces.md.
//
// A surface page attaches an external document to one of its elements. The host places a document web view inside that surface web view,
// lays it out with the margins that the page reported, and sends the document state only to that surface. The document web view is a subview of
// the surface web view, so it moves and hides together with the surface. It closes when the surface is removed or the surface page is read again.

import (
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// documentData is the directory inside the configuration directory that holds the persistent site data of document regions. It differs from the
// storage of the app document (docs/spec/native-surfaces.md#document-regions).
const documentData = "document-data"

var documentName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// DocumentRequest is a document region call of a surface page. Each call uses only the fields it needs.
type DocumentRequest struct {
	Surface  string   `json:"surface"`
	Document string   `json:"document"`
	URL      string   `json:"url,omitempty"`
	Action   string   `json:"action,omitempty"`
	Zoom     *float64 `json:"zoom,omitempty"`
	Offset   *int32   `json:"offset,omitempty"`
	// Message is the JSON value that documentPost sends to a plugin document.
	Message json.RawMessage `json:"message,omitempty"`
}

// DocumentMessage turns a message of a plugin document, {"message": value} or {"error": reason}, into the payload of
// the document-message event of the owning surface, or into the reason that the host writes to the application log.
func DocumentMessage(surface, document, value string) (payload map[string]any, reason string, err error) {
	var received struct {
		Message json.RawMessage `json:"message"`
		Error   *string         `json:"error"`
	}
	if err := json.Unmarshal([]byte(value), &received); err != nil {
		return nil, "", fmt.Errorf("document message %s is not JSON: %w", document, err)
	}
	if received.Error != nil {
		return nil, *received.Error, nil
	}
	if received.Message == nil {
		return nil, "", fmt.Errorf("document message %s has neither message nor error", document)
	}
	return map[string]any{"surface": surface, "document": document, "message": received.Message}, "", nil
}

// ZoomFactor is the text scale of the document (docs/spec/text-size.md). It is an error when it is missing or not a finite positive number.
func (r DocumentRequest) ZoomFactor() (float64, error) {
	if r.Zoom == nil || math.IsNaN(*r.Zoom) || math.IsInf(*r.Zoom, 0) || *r.Zoom <= 0 {
		return 0, fmt.Errorf("document zoom must be a finite positive number")
	}
	return *r.Zoom, nil
}

// DocumentState is the value of the document-state event.
type DocumentState struct {
	Surface  string          `json:"surface"`
	Document string          `json:"document"`
	State    json.RawMessage `json:"state"`
}

// DocumentKey is the pair of a surface and a document name.
type DocumentKey struct {
	Surface, Name string
}

// CheckDocument checks the surface ownership of the surface caller and returns the key.
func CheckDocument(caller string, req DocumentRequest) (DocumentKey, error) {
	if caller == "" || caller != req.Surface {
		return DocumentKey{}, fmt.Errorf("this document is not surface %q", req.Surface)
	}
	if !documentName.MatchString(req.Document) {
		return DocumentKey{}, fmt.Errorf("invalid document name %q", req.Document)
	}
	return DocumentKey{req.Surface, req.Document}, nil
}

func (s *Surfaces) checkDocument(viewID uint64, req DocumentRequest) (DocumentKey, error) {
	if err := s.authorizeSurface(viewID, req.Surface); err != nil {
		return DocumentKey{}, err
	}
	caller := s.surfaceOf(viewID)
	if caller == "" {
		caller = req.Surface
	}
	return CheckDocument(caller, req)
}

// Documents are the document regions of a window. A value is a document web view, and a region that is being created is nil.
type Documents struct {
	mu      sync.Mutex
	handles map[DocumentKey]unsafe.Pointer
}

func NewDocuments() *Documents { return &Documents{handles: map[DocumentKey]unsafe.Pointer{}} }

// Reserve takes a name. It is an error when the same name already exists.
func (d *Documents) Reserve(key DocumentKey) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.handles[key]; ok {
		return fmt.Errorf("document %q is already attached", key.Name)
	}
	d.handles[key] = nil
	return nil
}

// Set writes the created document to the reserved name. It returns false when the name was removed in the meantime.
func (d *Documents) Set(key DocumentKey, handle unsafe.Pointer) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.handles[key]; !ok {
		return false
	}
	d.handles[key] = handle
	return true
}

// Get returns the created document.
func (d *Documents) Get(key DocumentKey) (unsafe.Pointer, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if handle := d.handles[key]; handle != nil {
		return handle, nil
	}
	return nil, fmt.Errorf("document %q is not attached", key.Name)
}

// Remove removes the name and returns its document. It returns nil when the name was still being created.
func (d *Documents) Remove(key DocumentKey) (unsafe.Pointer, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	handle, ok := d.handles[key]
	if !ok {
		return nil, fmt.Errorf("document %q is not attached", key.Name)
	}
	delete(d.handles, key)
	return handle, nil
}

// RemoveSurface removes all names of a surface and returns the created documents.
func (d *Documents) RemoveSurface(surface string) []unsafe.Pointer {
	d.mu.Lock()
	defer d.mu.Unlock()
	var removed []unsafe.Pointer
	for key, handle := range d.handles {
		if key.Surface != surface {
			continue
		}
		delete(d.handles, key)
		if handle != nil {
			removed = append(removed, handle)
		}
	}
	return removed
}

// Names are the keys of the created documents by address.
func (d *Documents) Names() map[uint64]DocumentKey {
	d.mu.Lock()
	defer d.mu.Unlock()
	names := map[uint64]DocumentKey{}
	for key, handle := range d.handles {
		if handle != nil {
			names[uint64(uintptr(handle))] = key
		}
	}
	return names
}

// All are the created documents.
func (d *Documents) All() []unsafe.Pointer {
	d.mu.Lock()
	defer d.mu.Unlock()
	var all []unsafe.Pointer
	for _, handle := range d.handles {
		if handle != nil {
			all = append(all, handle)
		}
	}
	return all
}

var documentActions = map[string]int{"back": 0, "forward": 1, "reload": 2, "stop": 3, "entry": 4}

// DocumentGoAction returns the action number and the distance of a go request. entry needs a non-zero offset and
// the other actions do not accept an offset.
func DocumentGoAction(req DocumentRequest) (int, int, error) {
	action, ok := documentActions[req.Action]
	if !ok {
		return 0, 0, fmt.Errorf("unknown document action %q", req.Action)
	}
	if req.Action == "entry" {
		if req.Offset == nil || *req.Offset == 0 {
			return 0, 0, fmt.Errorf("document action entry requires a non-zero offset")
		}
		return action, int(*req.Offset), nil
	}
	if req.Offset != nil {
		return 0, 0, fmt.Errorf("document action %q does not take an offset", req.Action)
	}
	return action, 0, nil
}

// attachDocument creates a hidden document region inside a surface. It is an error when the same name already exists.
func (s *Surfaces) attachDocument(viewID uint64, req DocumentRequest) error {
	key, err := s.checkDocument(viewID, req)
	if err != nil {
		return err
	}
	if err := s.requireRegion(key.Surface, key.Name, "document", ""); err != nil {
		return err
	}
	if err := s.documents.Reserve(key); err != nil {
		return err
	}
	var handle unsafe.Pointer
	application.InvokeSync(func() {
		view := s.views[key.Surface]
		if view == nil || view.handle == nil {
			err = fmt.Errorf("surface %q has no view", key.Surface)
			return
		}
		s.mu.Lock()
		plugin := s.surfacePlugins[key.Surface]
		s.mu.Unlock()
		var folder string
		folder, err = PluginFolder(s.host.configDir, plugin)
		if err != nil {
			return
		}
		handle, err = system.CreateDocument(view.handle, filepath.Join(s.host.configDir, documentData), folder, plugin, func(state string) {
			s.documentChanged(key, state)
		})
		if err == nil {
			s.mu.Lock()
			dark := s.theme.Scheme == "dark"
			s.mu.Unlock()
			system.SetDocumentAppearance(handle, dark)
			system.SetDocumentBackground(handle, s.dialog())
			err = system.SetDocumentEvent(handle, func(event string) { s.documentEvent(key, event) })
		}
		if err == nil {
			err = system.SetDocumentMessage(handle, func(value string) { s.documentMessage(key, value) })
		}
	})
	if err != nil {
		s.documents.Remove(key)
		return err
	}
	// When the surface was removed during creation, the created document is closed. Registration and closing run on the UI thread.
	var registered bool
	application.InvokeSync(func() {
		registered = s.documents.Set(key, handle)
		if !registered {
			system.CloseDocument(handle)
		}
	})
	if !registered {
		return fmt.Errorf("surface %q closed while its document was created", key.Surface)
	}
	return nil
}

// documentChanged sends the document state only to the owning surface and notifies the host.window watchers. It is called on the UI thread.
func (s *Surfaces) documentChanged(key DocumentKey, state string) {
	payload := DocumentState{Surface: key.Surface, Document: key.Name, State: json.RawMessage(state)}
	s.emitToSurface(key.Surface, "document-state", payload)
	s.windowChanged()
}

// documentMessage sends a message of a plugin document to the owning surface, or writes its failure to the
// application log. It is called on the UI thread.
func (s *Surfaces) documentMessage(key DocumentKey, value string) {
	payload, reason, err := DocumentMessage(key.Surface, key.Name, value)
	if err != nil {
		LogError("document message "+key.Name, err)
		return
	}
	if reason != "" {
		LogError("document message "+key.Name, reason)
		return
	}
	s.emitToSurface(key.Surface, "document-message", payload)
}

func (s *Surfaces) documentEvent(key DocumentKey, event string) {
	payload := map[string]any{"surface": key.Surface, "document": key.Name, "event": json.RawMessage(event)}
	s.emitToSurface(key.Surface, "document-event", payload)
	s.windowChanged()
}

// withDocument runs run on the UI thread for an open document region.
func (s *Surfaces) withDocument(viewID uint64, req DocumentRequest, run func(handle unsafe.Pointer) error) error {
	key, err := s.checkDocument(viewID, req)
	if err != nil {
		return err
	}
	if err := s.requireRegion(key.Surface, key.Name, "document", ""); err != nil {
		return err
	}
	// The lookup and the use run as one task of the UI thread. Closing also happens on the UI thread together with unregistering, so
	// the looked-up handle is not released during this task.
	application.InvokeSync(func() {
		var handle unsafe.Pointer
		handle, err = s.documents.Get(key)
		if err == nil {
			err = run(handle)
		}
	})
	return err
}

func (s *Surfaces) loadDocument(viewID uint64, req DocumentRequest) error {
	return s.withDocument(viewID, req, func(handle unsafe.Pointer) error {
		if !system.LoadDocument(handle, req.URL) {
			return fmt.Errorf("only http, https, file, and sok addresses can be opened: %q", req.URL)
		}
		return nil
	})
}

// postDocument sends a JSON message to the current plugin document of a region.
func (s *Surfaces) postDocument(viewID uint64, req DocumentRequest) error {
	if !json.Valid(req.Message) {
		return fmt.Errorf("documentPost requires a JSON message")
	}
	return s.withDocument(viewID, req, func(handle unsafe.Pointer) error {
		if !system.PostDocument(handle, string(req.Message)) {
			return fmt.Errorf("document %s shows no plugin document", req.Document)
		}
		return nil
	})
}

// zoomDocument sets the page zoom of the document from the text scale.
func (s *Surfaces) zoomDocument(viewID uint64, req DocumentRequest) error {
	zoom, err := req.ZoomFactor()
	if err != nil {
		return err
	}
	return s.withDocument(viewID, req, func(handle unsafe.Pointer) error {
		if !system.ZoomDocument(handle, zoom) {
			return fmt.Errorf("document zoom %g was rejected", zoom)
		}
		return nil
	})
}

// goDocument runs history navigation, opening a history entry, reload, and stop, and returns whether it ran.
func (s *Surfaces) goDocument(viewID uint64, req DocumentRequest) (bool, error) {
	action, offset, err := DocumentGoAction(req)
	if err != nil {
		return false, err
	}
	var done bool
	err = s.withDocument(viewID, req, func(handle unsafe.Pointer) error {
		done = system.GoDocument(handle, action, offset)
		return nil
	})
	return done, err
}

func (s *Surfaces) detachDocument(viewID uint64, req DocumentRequest) error {
	key, err := s.checkDocument(viewID, req)
	if err != nil {
		return err
	}
	// Unregistering and closing run as one task of the UI thread. No other task uses the handle in between.
	application.InvokeSync(func() {
		var handle unsafe.Pointer
		handle, err = s.documents.Remove(key)
		if err == nil && handle != nil {
			system.CloseDocument(handle)
		}
	})
	if err != nil {
		return err
	}
	s.windowChanged()
	return nil
}

// closeSurfaceDocuments closes all document regions of a surface. Call it on the UI thread.
func (s *Surfaces) closeSurfaceDocuments(surface string) {
	handles := s.documents.RemoveSurface(surface)
	for _, handle := range handles {
		system.CloseDocument(handle)
	}
	if len(handles) > 0 {
		s.windowChanged()
	}
}

// surfaceCommitted registers and cleans up the previous document and the picture regions when the surface page started to show a new document.
// The new document creates its own entries and document regions again.
func (s *Surfaces) surfaceCommitted(viewID uint64) {
	surface := s.surfaceOf(viewID)
	if surface == "" {
		return
	}
	application.InvokeSync(func() {
		s.closeSurfaceDocuments(surface)
		s.closeSurfaceImages(surface)
		delete(s.compositionRevisions, surface)
		s.images.BeginGeneration(surface)
	})
	s.surfacesClosed([]string{surface})
}

// setDocumentsBackground dims the document regions while a dialog is open. Call it on the UI thread.
func (s *Surfaces) setDocumentsBackground(enabled bool) {
	for _, handle := range s.documents.All() {
		system.SetDocumentBackground(handle, enabled)
	}
}

// The event goes to the app DOM, and the receiver of the module checks the surface owner of the payload.
func (s *Surfaces) emitToSurface(surface, name string, data any) {
	if s.views[surface] == nil {
		LogInfo("document", fmt.Sprintf("native event %s of closed surface %q arrived after the surface closed", name, surface))
		return
	}
	s.window.EmitEvent(name, data)
}

// imageChanged sends the picture region event only to the owning surface and notifies the host.window watchers. It is called on the UI thread.
func (s *Surfaces) imageChanged(key ImageKey, event string) {
	// Every event of a native region is recorded with its whole body before it is relayed (docs/spec/diagnostics.md).
	PerformanceObserve("host", func() map[string]any {
		return map[string]any{"event": "region", "surface": key.Surface, "name": key.Name, "body": json.RawMessage(event)}
	})
	payload := map[string]any{"surface": key.Surface, "name": key.Name, "event": json.RawMessage(event)}
	s.emitToSurface(key.Surface, "image-event", payload)
	s.windowChanged()
}

// attachImage creates a hidden picture region inside a surface. It is an error when the same name already exists.
func (s *Surfaces) attachImage(viewID uint64, req ImageRequest) error {
	key, err := s.checkImage(viewID, req)
	if err != nil {
		return err
	}
	if req.Sidecar == "" {
		return fmt.Errorf("image %q: attach requires a sidecar", req.Name)
	}
	if err := s.requireRegion(key.Surface, key.Name, "image", req.Sidecar); err != nil {
		return err
	}
	if err := s.images.Reserve(key, &ImageOwner{SidecarName: req.Sidecar, SidecarOwner: s}); err != nil {
		return err
	}
	var handle unsafe.Pointer
	application.InvokeSync(func() {
		view := s.views[key.Surface]
		if view == nil || view.handle == nil {
			err = fmt.Errorf("surface %q has no view", key.Surface)
			return
		}
		handle, err = system.CreateImage(view.handle, key.Name, func(event string) {
			s.imageChanged(key, event)
		})
	})
	if err != nil {
		s.images.Remove(key)
		return err
	}
	// When the surface was removed during creation, the created picture region is closed. Registration and closing run on the UI thread.
	var registered bool
	application.InvokeSync(func() {
		registered = s.images.Set(key, handle)
		if !registered {
			system.CloseImage(handle)
		}
	})
	if !registered {
		return fmt.Errorf("surface %q closed while its image was created", key.Surface)
	}
	s.windowChanged()
	return nil
}

// withImage runs run on the UI thread for an open picture region.
func (s *Surfaces) withImage(viewID uint64, req ImageRequest, run func(handle unsafe.Pointer) error) error {
	key, err := s.checkImage(viewID, req)
	if err != nil {
		return err
	}
	if err := s.requireRegion(key.Surface, key.Name, "image", ""); err != nil {
		return err
	}
	// The lookup and the use run as one task of the UI thread. Closing also happens on the UI thread together with unregistering, so
	// the looked-up handle is not released during this task.
	application.InvokeSync(func() {
		var handle unsafe.Pointer
		handle, err = s.images.Get(key)
		if err == nil {
			err = run(handle)
		}
	})
	return err
}

func (s *Surfaces) focusImage(viewID uint64, req ImageRequest) error {
	err := s.withImage(viewID, req, func(handle unsafe.Pointer) error {
		system.FocusImage(handle)
		return nil
	})
	if err == nil {
		s.windowChanged()
	}
	return err
}

func (s *Surfaces) caretImage(viewID uint64, req ImageRequest, x, y, w, h float64) error {
	return s.withImage(viewID, req, func(handle unsafe.Pointer) error {
		system.CaretImage(handle, x, y, w, h)
		return nil
	})
}

func (s *Surfaces) textImage(viewID uint64, req ImageRequest, text string) error {
	return s.withImage(viewID, req, func(handle unsafe.Pointer) error {
		system.TextImage(handle, text)
		return nil
	})
}

// closeSurfaceImages closes all picture regions of a surface. Call it on the UI thread.
func (s *Surfaces) closeSurfaceImages(surface string) {
	s.images.CloseSurface(surface, func(handle unsafe.Pointer) {
		system.CloseImage(handle)
	})
	// Announces the region change.
}

func (s *Surfaces) detachImage(viewID uint64, req ImageRequest) error {
	key, err := s.checkImage(viewID, req)
	if err != nil {
		return err
	}
	// Unregistering and closing run as one task of the UI thread. No other task uses the handle in between.
	application.InvokeSync(func() {
		var handle unsafe.Pointer
		handle, err = s.images.Remove(key)
		if err == nil && handle != nil {
			system.CloseImage(handle)
		}
	})
	if err != nil {
		return err
	}
	s.windowChanged()
	return nil
}
