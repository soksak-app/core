package host

// Document regions inside a surface page, as in the section Document regions of docs/spec/native-surfaces.md.
//
// A surface page attaches an external document to one of its elements. The host places a document web view inside that surface web view,
// lays it out with the margins that the page reported, and sends the document state only to that surface. The document web view is a subview of
// the surface web view, so it moves and hides together with the surface. It closes when the surface is removed or the surface page is read again.

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
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
	// Stream is the stream of a subscribe request: elements or requests.
	Stream string `json:"stream,omitempty"`
	// Handle is the subscription of an unsubscribe request.
	Handle *uint64 `json:"handle,omitempty"`
	// Message is the JSON value that documentPost sends to a plugin document.
	Message json.RawMessage `json:"message,omitempty"`
	// InteractionState is the base64 interactionState that documentAttach restores into the new region before its first load.
	InteractionState *string `json:"interactionState,omitempty"`
}

// RestoreState is the interactionState that documentAttach restores, or an empty string for none. An empty value is an error.
func (r DocumentRequest) RestoreState() (string, error) {
	if r.InteractionState == nil {
		return "", nil
	}
	if *r.InteractionState == "" {
		return "", fmt.Errorf("document interactionState must not be empty")
	}
	return *r.InteractionState, nil
}

// DocumentReport is the reply of documentQuery: whether the region plays audible media, whether capture is active and whether
// a frame holds a form flag (docs/spec/plugins.md#memory-saver).
type DocumentReport struct {
	Media   bool `json:"media"`
	Capture bool `json:"capture"`
	Form    bool `json:"form"`
}

// ParseDocumentReport turns the query reply of native, {media, capture, form} or {error}, into the report of the document, or
// into the error that names the document.
func ParseDocumentReport(document, reply string) (DocumentReport, error) {
	var received struct {
		Media   *bool   `json:"media"`
		Capture *bool   `json:"capture"`
		Form    *bool   `json:"form"`
		Error   *string `json:"error"`
	}
	invalid := fmt.Errorf("document %s answered an invalid query reply: %s", document, reply)
	if err := json.Unmarshal([]byte(reply), &received); err != nil {
		return DocumentReport{}, invalid
	}
	if received.Error != nil {
		return DocumentReport{}, fmt.Errorf("document %s: %s", document, *received.Error)
	}
	if received.Media == nil || received.Capture == nil || received.Form == nil {
		return DocumentReport{}, invalid
	}
	return DocumentReport{Media: *received.Media, Capture: *received.Capture, Form: *received.Form}, nil
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
	// views is the view channel of each view surface. A record leaves with the view of its surface.
	views map[string]*viewChannel
}

func NewDocuments() *Documents {
	return &Documents{handles: map[DocumentKey]unsafe.Pointer{}, views: map[string]*viewChannel{}}
}

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
	if key.Name == viewRegionName {
		delete(d.views, key.Surface)
	}
	return handle, nil
}

// RemoveSurface removes all names of a surface and returns the created documents.
func (d *Documents) RemoveSurface(surface string) []unsafe.Pointer {
	d.mu.Lock()
	defer d.mu.Unlock()
	var removed []unsafe.Pointer
	delete(d.views, surface)
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
	restore, err := req.RestoreState()
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
		handle, err = system.CreateDocument(view.handle, filepath.Join(s.host.configDir, documentData), folder, plugin, "", func(state string) {
			s.documentChanged(key, state)
		})
		// The history is restored before anything else uses the new region, so it loads the restored entry first.
		if err == nil && restore != "" {
			if refusal := system.RestoreDocument(handle, restore); refusal != nil {
				system.CloseDocument(handle)
				err = fmt.Errorf("document %s: %w", key.Name, refusal)
			}
		}
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
		if err == nil {
			err = system.SetDocumentStream(handle, func(value string) { s.documentStream(key, value) })
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

// viewRegionName is the document name of the view web view of a view surface. No composition region has an empty name, so the view
// cannot collide with a region, and the view closes with the other documents of its surface.
const viewRegionName = ""

// attachView creates the view web view of a view surface with the view configuration (isView) and loads sok://<plugin>/<page> into it.
// The view state is not reported by this step. It runs on the UI thread.
func (s *Surfaces) attachView(surfaceID string, surface unsafe.Pointer, directory, folder, plugin, page, channel string) error {
	key := DocumentKey{Surface: surfaceID, Name: viewRegionName}
	if err := s.documents.Reserve(key); err != nil {
		return err
	}
	handle, err := system.CreateDocument(surface, directory, folder, plugin, channel, func(state string) {
		if err := s.viewState(surfaceID, state); err != nil {
			LogError("view channel", err)
		}
	})
	if err == nil {
		err = system.SetViewMessage(handle, func(value string) {
			s.viewReceived(surfaceID, handle, value)
		})
	}
	if err == nil {
		err = system.SetViewEnded(handle, func() {
			LogError("view channel", surfaceID+": the view process ended")
			s.viewFailed(surfaceID, handle)
		})
	}
	if err == nil {
		err = system.SetViewResponsiveness(handle, func(responsive bool) {
			s.viewResponsiveness(surfaceID, plugin, responsive)
		})
	}
	if err == nil && !system.LoadDocument(handle, "sok://"+plugin+"/"+page) {
		system.CloseDocument(handle)
		err = fmt.Errorf("view of surface %q cannot load sok://%s/%s", surfaceID, plugin, page)
	}
	if err != nil {
		s.documents.Remove(key)
		return err
	}
	if !s.documents.Set(key, handle) {
		system.CloseDocument(handle)
		return fmt.Errorf("surface %q closed while its view was created", surfaceID)
	}
	s.documents.registerView(surfaceID, plugin)
	EmitHost(LevelDebug, "host.trace.view.process-request", map[string]any{"plugin": plugin, "surface": surfaceID})
	return nil
}

// viewResponsiveness relays a responsiveness notice of the view of surface: it writes the trace event of the notice and sends the
// view-responsiveness event to the owning surface. It ends no call of the view (docs/spec/native-surfaces.md#view-surfaces).
func (s *Surfaces) viewResponsiveness(surface, plugin string, responsive bool) {
	if responsive {
		EmitHost(LevelDebug, "host.trace.view.responsive", map[string]any{"plugin": plugin, "surface": surface})
	} else {
		EmitHost(LevelDebug, "host.trace.view.unresponsive", map[string]any{"plugin": plugin, "surface": surface})
	}
	s.emitToSurface(surface, "view-responsiveness", map[string]any{"surface": surface, "plugin": plugin, "responsive": responsive})
}

// syncView creates the view of a view surface when the surface has none, and places the view over the whole surface. It runs on the UI thread.
func (s *Surfaces) syncView(surfaceID string, surface unsafe.Pointer, plugin, page string, visible bool) error {
	key := DocumentKey{Surface: surfaceID, Name: viewRegionName}
	spec := s.viewRecords().track(surfaceID, surface, plugin, page, visible)
	// A view that failed beyond the restart limit is not created again until its surface is removed (view_lifecycle.go).
	if s.viewRecords().isStopped(surfaceID) {
		return nil
	}
	handle, err := s.documents.Get(key)
	if err != nil {
		if spec.folder == "" {
			folder, folderErr := PluginFolder(s.host.configDir, plugin)
			if folderErr != nil {
				return folderErr
			}
			spec.folder = folder
			spec.directory = filepath.Join(s.host.configDir, documentData)
		}
		if err := s.attachView(surfaceID, surface, spec.directory, spec.folder, plugin, page, viewChannelScript); err != nil {
			return err
		}
		if handle, err = s.documents.Get(key); err != nil {
			return err
		}
	}
	system.PlaceDocument(handle, 0, 0, 0, 0, visible)
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

// documentStream delivers a stream message of a document region to the subscriptions of its stream, and acknowledges a snapshot to native
// after the delivery. It is called on the UI thread.
func (s *Surfaces) documentStream(key DocumentKey, value string) {
	result, err := s.streams.Deliver(key, value)
	if err != nil {
		LogError("document stream "+key.Name, err)
		return
	}
	for _, delivery := range result.Deliveries {
		payload := map[string]any{"surface": delivery.Surface, "document": key.Name, "stream": delivery.Stream, "handle": delivery.Handle, "message": delivery.Message}
		s.emitToSurface(delivery.Surface, "document-stream", payload)
	}
	if !result.Ack {
		return
	}
	handle, err := s.documents.Get(key)
	if err != nil {
		LogError("document stream "+key.Name, err)
		return
	}
	if !system.AckDocumentStream(handle, result.Seq) {
		LogError("document stream "+key.Name, StreamAckRefusal(key, streamElements, result.Seq))
	}
}

// applyStreamEffects turns the collection of the streams of the regions on or off. It is called on the UI thread, and it fails with the
// name of the stream that native refused.
func (s *Surfaces) applyStreamEffects(effects []StreamEffect) error {
	for _, effect := range effects {
		handle, err := s.documents.Get(effect.Key)
		if err != nil {
			return err
		}
		if !system.SetDocumentStreamOn(handle, effect.Stream, effect.On) {
			return fmt.Errorf("document %q does not accept stream %q", effect.Key.Name, effect.Stream)
		}
	}
	return nil
}

// subscribeDocument opens a subscription of a stream of a document region and returns its handle. The first message of a requests subscription
// is the request log, and the subscription receives it before native starts the stream.
func (s *Surfaces) subscribeDocument(viewID uint64, req DocumentRequest) (uint64, error) {
	key, err := s.checkDocument(viewID, req)
	if err != nil {
		return 0, err
	}
	if err := checkStream(req.Stream); err != nil {
		return 0, err
	}
	if err := s.requireRegion(key.Surface, key.Name, "document", ""); err != nil {
		return 0, err
	}
	var handle uint64
	application.InvokeSync(func() {
		var effects []StreamEffect
		var initial json.RawMessage
		handle, effects, initial, err = s.streams.Subscribe(key, req.Stream)
		if err != nil {
			return
		}
		if initial != nil {
			s.emitToSurface(key.Surface, "document-stream", map[string]any{"surface": key.Surface, "document": key.Name, "stream": req.Stream, "handle": handle, "message": initial})
		}
		if err = s.applyStreamEffects(effects); err != nil {
			s.streams.Abandon(handle)
		}
	})
	return handle, err
}

// unsubscribeDocument ends a subscription of a document region. The last removal of a stream turns its collection off.
func (s *Surfaces) unsubscribeDocument(viewID uint64, req DocumentRequest) error {
	key, err := s.checkDocument(viewID, req)
	if err != nil {
		return err
	}
	if req.Handle == nil {
		return fmt.Errorf("document stream unsubscribe requires a handle")
	}
	if err := s.requireRegion(key.Surface, key.Name, "document", ""); err != nil {
		return err
	}
	application.InvokeSync(func() {
		var effects []StreamEffect
		effects, err = s.streams.Unsubscribe(key, *req.Handle)
		if err == nil {
			err = s.applyStreamEffects(effects)
		}
	})
	return err
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

// queryDocument asks a document region for its media, capture and form state (docs/spec/plugins.md#memory-saver). The reply
// of native arrives later on the UI thread, and this call waits for it outside the UI thread.
func (s *Surfaces) queryDocument(viewID uint64, req DocumentRequest) (DocumentReport, error) {
	replies := make(chan string, 1)
	err := s.withDocument(viewID, req, func(handle unsafe.Pointer) error {
		system.QueryDocument(handle, func(reply string) { replies <- reply })
		return nil
	})
	if err != nil {
		return DocumentReport{}, err
	}
	return ParseDocumentReport(req.Document, <-replies)
}

// documentInteractionState returns the interactionState of a document region as base64, empty when the web view yields none.
func (s *Surfaces) documentInteractionState(viewID uint64, req DocumentRequest) (string, error) {
	var state string
	err := s.withDocument(viewID, req, func(handle unsafe.Pointer) error {
		var ok bool
		if state, ok = system.DocumentInteractionState(handle); !ok {
			return fmt.Errorf("document %s is closed", req.Document)
		}
		return nil
	})
	return state, err
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
		if err == nil {
			s.streams.RemoveRegion(key)
		}
	})
	if err != nil {
		return err
	}
	s.windowChanged()
	return nil
}

// surfaceTerminated removes the subscriptions of a surface whose WebContent process ended and turns off the streams that lose their last
// subscriber. The regions stay attached until the framework reloads the page, which commits a new document.
func (s *Surfaces) surfaceTerminated(viewID uint64) {
	surface := s.surfaceOf(viewID)
	if surface == "" {
		return
	}
	application.InvokeSync(func() {
		for _, effect := range s.streams.RemoveSurface(surface) {
			if err := s.applyStreamEffects([]StreamEffect{effect}); err != nil {
				LogError("document stream "+effect.Key.Name, err)
			}
		}
	})
}

// closeSurfaceDocuments closes all document regions of a surface. Call it on the UI thread.
func (s *Surfaces) closeSurfaceDocuments(surface string) {
	// The regions close with their documents, so their stream effects are not applied.
	s.streams.RemoveSurface(surface)
	handles := s.documents.RemoveSurface(surface)
	for _, handle := range handles {
		system.CloseDocument(handle)
	}
	if len(handles) > 0 {
		s.windowChanged()
	}
}

// surfaceCommitted registers and cleans up the previous document and the image regions when the surface page started to show a new document.
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
	s.windowEvent(name, data)
}

// imageChanged sends the image region event only to the owning surface and notifies the host.window watchers. It is called on the UI thread.
func (s *Surfaces) imageChanged(key ImageKey, event string) {
	// Every event of a native region is recorded with its whole body before it is relayed (docs/spec/diagnostics.md).
	PerformanceObserve("host", func() map[string]any {
		return map[string]any{"event": "region", "surface": key.Surface, "name": key.Name, "body": json.RawMessage(event)}
	})
	if err := RecordInputRelay(key.Surface, key.Name, event); err != nil {
		LogError("input relay", err)
	}
	payload := map[string]any{"surface": key.Surface, "name": key.Name, "event": json.RawMessage(event)}
	s.emitToSurface(key.Surface, "image-event", payload)
	s.windowChanged()
}

// attachImage creates a hidden image region inside a surface. It is an error when the same name already exists.
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
	// When the surface was removed during creation, the created image region is closed. Registration and closing run on the UI thread.
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

// withImage runs run on the UI thread for an open image region.
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

// closeSurfaceImages closes all image regions of a surface. Call it on the UI thread.
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

// Stream names of a document region (docs/spec/native-surfaces.md#document-streams).
const (
	streamElements = "elements"
	streamRequests = "requests"
)

// requestLogLimit is the number of request entries that a document region keeps for a new subscription.
const requestLogLimit = 200

// checkStream returns the error for a stream name that is neither elements nor requests.
func checkStream(name string) error {
	if name != streamElements && name != streamRequests {
		return fmt.Errorf("unknown document stream %q", name)
	}
	return nil
}

// DocumentSubscription is the reply of a stream subscription: the handle that ends it.
type DocumentSubscription struct {
	Handle uint64 `json:"handle"`
}

// StreamEffect is a change of the collection of a stream of a document region. The caller applies it to the native document with
// the same key, and the effect of a removal is the turn off of a stream that has no subscriber.
type StreamEffect struct {
	Key    DocumentKey
	Stream string
	On     bool
}

// StreamDelivery is one message of a document stream for one subscription. It is sent only to the surface that made the subscription.
type StreamDelivery struct {
	Surface string
	Handle  uint64
	Stream  string
	Message json.RawMessage
}

// StreamResult is the outcome of a stream message of native. Ack is true for a snapshot, and native is acknowledged with Seq after the deliveries.
type StreamResult struct {
	Deliveries []StreamDelivery
	Ack        bool
	Seq        uint64
}

// StreamAckRefusal is the error of an acknowledgement that native refuses. It names the document, the stream and the seq.
func StreamAckRefusal(key DocumentKey, stream string, seq uint64) error {
	return fmt.Errorf("document %q stream %s: seq %d was not sent", key.Name, stream, seq)
}

type streamSubscriptionState struct {
	key    DocumentKey
	stream string
}

// streamLog is the request log of a document region: the most recent entries and the number of entries that the log dropped since the last reset.
type streamLog struct {
	entries []json.RawMessage
	dropped int64
}

// DocumentStreams are the stream subscriptions of the document regions of a window. The host counts the subscriptions of each region and stream;
// the first subscription of a stream turns its collection on and the last removal turns it off. A region that has no subscription has no request
// log. It does not call native, so the caller applies the returned effects on the UI thread.
type DocumentStreams struct {
	mu   sync.Mutex
	next uint64
	subs map[uint64]streamSubscriptionState
	logs map[DocumentKey]*streamLog
}

func NewDocumentStreams() *DocumentStreams {
	return &DocumentStreams{subs: map[uint64]streamSubscriptionState{}, logs: map[DocumentKey]*streamLog{}}
}

// countLocked returns the subscriptions of a stream of a region. The caller holds mu.
func (d *DocumentStreams) countLocked(key DocumentKey, stream string) int {
	n := 0
	for _, sub := range d.subs {
		if sub.key == key && sub.stream == stream {
			n++
		}
	}
	return n
}

// releaseLocked releases the request log of a region that has no subscription. The caller holds mu.
func (d *DocumentStreams) releaseLocked(key DocumentKey) {
	for _, sub := range d.subs {
		if sub.key == key {
			return
		}
	}
	delete(d.logs, key)
}

// Subscribers returns the number of subscriptions of a stream of a region.
func (d *DocumentStreams) Subscribers(key DocumentKey, stream string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.countLocked(key, stream)
}

// LogState returns the number of entries in the request log of a region and the number of entries it dropped since the last reset.
func (d *DocumentStreams) LogState(key DocumentKey) (int, int64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	log := d.logs[key]
	if log == nil {
		return 0, 0
	}
	return len(log.entries), log.dropped
}

// logMessage is the entries message of the request log: the entries and the dropped count.
func logMessage(log *streamLog) (json.RawMessage, error) {
	entries := log.entries
	if entries == nil {
		// default: an empty log is sent as an empty array, so the page reads entries as a list in every message.
		entries = []json.RawMessage{}
	}
	return json.Marshal(struct {
		Type    string            `json:"type"`
		Entries []json.RawMessage `json:"entries"`
		Dropped int64             `json:"dropped"`
	}{"entries", entries, log.dropped})
}

// Subscribe registers a subscription of stream on the region key and returns its handle, the effects to apply, and the first message
// of the subscriber. The first message of a requests subscription is the request log; an elements subscription has none, and native
// sends its first snapshot when the stream turns on.
func (d *DocumentStreams) Subscribe(key DocumentKey, stream string) (uint64, []StreamEffect, json.RawMessage, error) {
	if err := checkStream(stream); err != nil {
		return 0, nil, nil, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.next++
	handle := d.next
	d.subs[handle] = streamSubscriptionState{key: key, stream: stream}
	var initial json.RawMessage
	if stream == streamRequests {
		log := d.logs[key]
		if log == nil {
			log = &streamLog{}
			d.logs[key] = log
		}
		message, err := logMessage(log)
		if err != nil {
			delete(d.subs, handle)
			d.releaseLocked(key)
			return 0, nil, nil, err
		}
		initial = message
	}
	var effects []StreamEffect
	if d.countLocked(key, stream) == 1 {
		effects = append(effects, StreamEffect{Key: key, Stream: stream, On: true})
	}
	return handle, effects, initial, nil
}

// Abandon removes a subscription whose stream native refused to turn on. It returns no effect because native did not turn the stream on.
func (d *DocumentStreams) Abandon(handle uint64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if sub, ok := d.subs[handle]; ok {
		delete(d.subs, handle)
		d.releaseLocked(sub.key)
	}
}

// Unsubscribe ends the subscription handle of the region key. It is an error when the handle is not a subscription of that region.
func (d *DocumentStreams) Unsubscribe(key DocumentKey, handle uint64) ([]StreamEffect, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	sub, ok := d.subs[handle]
	if !ok || sub.key != key {
		return nil, fmt.Errorf("document stream handle %d is not subscribed to document %q", handle, key.Name)
	}
	delete(d.subs, handle)
	var effects []StreamEffect
	if d.countLocked(key, sub.stream) == 0 {
		effects = append(effects, StreamEffect{Key: key, Stream: sub.stream, On: false})
	}
	d.releaseLocked(key)
	return effects, nil
}

// removeLocked removes the subscriptions that match and returns the turn-off effects of the streams that lose their last subscriber.
// The caller holds mu.
func (d *DocumentStreams) removeLocked(match func(DocumentKey) bool) []StreamEffect {
	lost := map[StreamEffect]bool{}
	for handle, sub := range d.subs {
		if !match(sub.key) {
			continue
		}
		delete(d.subs, handle)
		lost[StreamEffect{Key: sub.key, Stream: sub.stream}] = true
	}
	var effects []StreamEffect
	for effect := range lost {
		if d.countLocked(effect.Key, effect.Stream) == 0 {
			effects = append(effects, StreamEffect{Key: effect.Key, Stream: effect.Stream, On: false})
		}
	}
	for key := range d.logs {
		d.releaseLocked(key)
	}
	sort.Slice(effects, func(i, j int) bool {
		a, b := effects[i], effects[j]
		if a.Key.Surface != b.Key.Surface {
			return a.Key.Surface < b.Key.Surface
		}
		if a.Key.Name != b.Key.Name {
			return a.Key.Name < b.Key.Name
		}
		return a.Stream < b.Stream
	})
	return effects
}

// RemoveRegion removes the subscriptions of a closed region and releases its request log.
func (d *DocumentStreams) RemoveRegion(key DocumentKey) []StreamEffect {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.removeLocked(func(k DocumentKey) bool { return k == key })
}

// RemoveSurface removes the subscriptions of a surface: its page loaded a new document, its web content process ended, or its window closed.
func (d *DocumentStreams) RemoveSurface(surface string) []StreamEffect {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.removeLocked(func(k DocumentKey) bool { return k.Surface == surface })
}

// Deliver handles one stream message of native for the region key. It returns the deliveries to the subscriptions of the stream, and for a
// snapshot the seq that native is acknowledged with after the deliveries. A request entry that arrives while the region has no subscription
// belongs to a collection that is turned off, so it is not kept.
func (d *DocumentStreams) Deliver(key DocumentKey, value string) (StreamResult, error) {
	var envelope struct {
		Stream  string          `json:"stream"`
		Message json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal([]byte(value), &envelope); err != nil {
		return StreamResult{}, errors.New("document stream message is not JSON")
	}
	var message struct {
		Type    string            `json:"type"`
		Seq     *uint64           `json:"seq"`
		Entries []json.RawMessage `json:"entries"`
	}
	if err := json.Unmarshal(envelope.Message, &message); err != nil {
		return StreamResult{}, errors.New("document stream message is not JSON")
	}
	if err := checkStream(envelope.Stream); err != nil {
		return StreamResult{}, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	switch {
	case envelope.Stream == streamElements && message.Type == "snapshot":
		if message.Seq == nil {
			return StreamResult{}, errors.New(`document stream "elements" snapshot has no seq`)
		}
		deliveries := d.deliveriesLocked(key, streamElements, envelope.Message)
		return StreamResult{Deliveries: deliveries, Ack: true, Seq: *message.Seq}, nil
	case envelope.Stream == streamRequests && message.Type == "entries":
		if message.Entries == nil {
			return StreamResult{}, errors.New(`document stream "requests" entries message has no entries`)
		}
		log := d.logs[key]
		if log == nil {
			return StreamResult{}, nil
		}
		log.entries = append(log.entries, message.Entries...)
		if overflow := len(log.entries) - requestLogLimit; overflow > 0 {
			log.dropped += int64(overflow)
			log.entries = append([]json.RawMessage(nil), log.entries[overflow:]...)
		}
		body, err := json.Marshal(struct {
			Type    string            `json:"type"`
			Entries []json.RawMessage `json:"entries"`
			Dropped int64             `json:"dropped"`
		}{"entries", message.Entries, log.dropped})
		if err != nil {
			return StreamResult{}, err
		}
		return StreamResult{Deliveries: d.deliveriesLocked(key, streamRequests, body)}, nil
	case message.Type == "reset":
		if envelope.Stream == streamRequests {
			if log := d.logs[key]; log != nil {
				log.entries = nil
				log.dropped = 0
			}
		}
		return StreamResult{Deliveries: d.deliveriesLocked(key, envelope.Stream, json.RawMessage(`{"type":"reset"}`))}, nil
	default:
		return StreamResult{}, fmt.Errorf("document stream %q sent an unknown message type %q", envelope.Stream, message.Type)
	}
}

// deliveriesLocked returns the message for each subscription of a stream of the region, in the order of the handles. The caller holds mu.
func (d *DocumentStreams) deliveriesLocked(key DocumentKey, stream string, body json.RawMessage) []StreamDelivery {
	var handles []uint64
	for handle, sub := range d.subs {
		if sub.key == key && sub.stream == stream {
			handles = append(handles, handle)
		}
	}
	sort.Slice(handles, func(i, j int) bool { return handles[i] < handles[j] })
	deliveries := make([]StreamDelivery, 0, len(handles))
	for _, handle := range handles {
		deliveries = append(deliveries, StreamDelivery{Surface: key.Surface, Handle: handle, Stream: stream, Message: body})
	}
	return deliveries
}

// viewChannelPath is the path of the view channel script in the bundled frontend, where the staging tool places the plugin-api package.
const viewChannelPath = "modules/@soksak/plugin-api/view-start.js"

// viewChannelScript is the text of the view channel script that each view configuration runs before its page.
var viewChannelScript string

// viewChannelMarker is the field that each host message to a view carries.
const viewChannelMarker = 1

// viewChannel is the channel of one view surface: the plugin of its view and its ready document. An empty document means that no
// ready document is recorded.
type viewChannel struct {
	plugin   string
	document string
	// processReady is set by the first ready message of the view, which writes host.trace.view.process-ready once.
	processReady bool
}

// firstReady reports whether the view of surface has no ready message yet, and records that it has one now. A view without a channel
// reports false.
func (d *Documents) firstReady(surface string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	channel, ok := d.views[surface]
	if !ok || channel.processReady {
		return false
	}
	channel.processReady = true
	return true
}

// registerView records the plugin of the view of surface. It runs when the view is created.
func (d *Documents) registerView(surface, plugin string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.views[surface] = &viewChannel{plugin: plugin}
}

// view returns the channel of the view of surface, and false when the surface has no view.
func (d *Documents) view(surface string) (viewChannel, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	channel, ok := d.views[surface]
	if !ok {
		return viewChannel{}, false
	}
	return *channel, true
}

// viewSurfaces returns the surfaces that have a view, in order.
func (d *Documents) viewSurfaces() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	surfaces := make([]string, 0, len(d.views))
	for surface := range d.views {
		surfaces = append(surfaces, surface)
	}
	sort.Strings(surfaces)
	return surfaces
}

// setReadyDocument records document as the ready document of the view of surface, and clears the record when document is empty.
func (d *Documents) setReadyDocument(surface, document string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	channel, ok := d.views[surface]
	if !ok {
		return false
	}
	channel.document = document
	return true
}

// viewReceived handles one message of the sok-view handler of the view handle of surface and writes its failure to the application log.
// It runs on the UI thread.
func (s *Surfaces) viewReceived(surface string, handle unsafe.Pointer, value string) {
	err := s.viewMessage(surface, value)
	if err == nil {
		return
	}
	LogError("view channel", err)
	var overflow viewOverflow
	if errors.As(err, &overflow) {
		// The view has lost messages, so it is closed and created again (docs/plans/plugin-processes.md, rule 4).
		s.viewFailed(surface, handle)
	}
}

// viewFailed handles the end of the WebContent process of the view handle of surface, or a queue overflow of that view. It runs on the UI
// thread.
func (s *Surfaces) viewFailed(surface string, handle unsafe.Pointer) {
	key := DocumentKey{Surface: surface, Name: viewRegionName}
	current, err := s.documents.Get(key)
	if err != nil || current != handle {
		// The handle belongs to a view that was already closed or replaced, so its failure is already counted.
		return
	}
	if _, err := s.documents.Remove(key); err != nil {
		LogError("view channel", err)
		return
	}
	system.CloseDocument(handle)
	lifecycle := s.viewRecords()
	spec := lifecycle.specs[surface]
	if !lifecycle.fail(surface) {
		reason := viewStopReason()
		LogError("view channel", fmt.Errorf("%s: %s", surface, reason))
		if spec == nil {
			LogError("view channel", fmt.Errorf("%s: the view record is missing, so the view-stopped event is not sent", surface))
			return
		}
		s.emitToSurface(surface, "view-stopped", viewStoppedEvent(surface, spec.plugin, reason))
		return
	}
	if spec == nil {
		LogError("view channel", fmt.Errorf("%s: the view record is missing, so the view is not created again", surface))
		return
	}
	if err := s.syncView(surface, spec.native, spec.plugin, spec.page, spec.visible); err != nil {
		LogError("view channel", err)
	}
}

// viewMessage dispatches one message of the sok-view handler of the view of surface. The message is {"message": value} for a message
// of the view and {"error": reason} for a message from another frame. It returns the reason that the host writes to the application
// log, or nil when the message needs no log line.
func (s *Surfaces) viewMessage(surface, value string) error {
	var received struct {
		Message json.RawMessage `json:"message"`
		Error   *string         `json:"error"`
	}
	if err := json.Unmarshal([]byte(value), &received); err != nil {
		return fmt.Errorf("%s: view message is not JSON: %w", surface, err)
	}
	if received.Error != nil {
		return errors.New(*received.Error)
	}
	if received.Message == nil {
		return fmt.Errorf("%s: view message has neither message nor error", surface)
	}
	channel, ok := s.documents.view(surface)
	if !ok {
		return fmt.Errorf("%s: view channel message of a surface without a view", surface)
	}
	// A reply of the view answers a request of the main page, and goes to the main page as view-reply (docs/spec/native-surfaces.md#view-surfaces).
	reply, isReply, err := ViewReplyEvent(surface, channel.plugin, received.Message)
	if err != nil {
		return err
	}
	if isReply {
		s.emitToSurface(surface, "view-reply", reply)
		return nil
	}
	payload, isCall, err := ViewCallEvent(surface, channel.plugin, received.Message)
	if err != nil {
		return err
	}
	if isCall {
		// A call request goes to the main page of the window, which answers it (docs/spec/native-surfaces.md#view-surfaces).
		s.emitToSurface(surface, "view-call", payload)
		return nil
	}
	var event struct {
		Event    string `json:"event"`
		Plugin   string `json:"plugin"`
		Document string `json:"document"`
		Reason   string `json:"reason"`
	}
	if err := json.Unmarshal(received.Message, &event); err != nil {
		return fmt.Errorf("%s: view event is not an object: %w", surface, err)
	}
	switch event.Event {
	case "view.ready":
		if event.Plugin != channel.plugin || event.Document == "" {
			return fmt.Errorf("%s: view.ready names plugin %q and document %q, want plugin %q", surface, event.Plugin, event.Document, channel.plugin)
		}
		s.documents.setReadyDocument(surface, event.Document)
		if s.documents.firstReady(surface) {
			EmitHost(LevelDebug, "host.trace.view.process-ready", map[string]any{"plugin": event.Plugin, "surface": surface})
		}
		// The current theme is the first message to a ready document (docs/spec/native-surfaces.md#view-surfaces).
		return s.postView(surface, map[string]any{"event": "theme", "data": s.Theme()})
	case "view.error":
		if strings.HasPrefix(event.Reason, viewQueueFullPrefix) {
			return viewOverflow{reason: event.Reason}
		}
		return errors.New(event.Reason)
	}
	return fmt.Errorf("%s: view event %q is unknown", surface, event.Event)
}

// viewState records the navigation state of the view of surface. A loading document clears the ready record of the view, so the
// next ready message of the new document is the first record of it.
func (s *Surfaces) viewState(surface, state string) error {
	var loaded struct {
		Loading bool `json:"loading"`
	}
	if err := json.Unmarshal([]byte(state), &loaded); err != nil {
		return fmt.Errorf("%s: view state is not JSON: %w", surface, err)
	}
	if loaded.Loading {
		s.documents.setReadyDocument(surface, "")
	}
	return nil
}

// postView posts message to the ready document of the view of surface, with the field sok 1. It returns an error when the view has no
// ready document or when the document refuses the message.
func (s *Surfaces) postView(surface string, message map[string]any) error {
	ready, err := s.sendToView(surface, message)
	if err != nil {
		return err
	}
	if !ready {
		return fmt.Errorf("%s has no ready document", surface)
	}
	return nil
}

// sendToView posts message to the ready document of the view of surface and reports whether the view has one. A view without a ready
// document is not an error here, so the theme of a view that is not ready is skipped.
func (s *Surfaces) sendToView(surface string, message map[string]any) (bool, error) {
	channel, ok := s.documents.view(surface)
	if !ok || channel.document == "" {
		return false, nil
	}
	handle, err := s.documents.Get(DocumentKey{Surface: surface, Name: viewRegionName})
	if err != nil {
		return false, err
	}
	message["sok"] = viewChannelMarker
	data, err := json.Marshal(message)
	if err != nil {
		return false, err
	}
	if !system.PostDocument(handle, string(data)) {
		return false, fmt.Errorf("%s: the view document refused the message", surface)
	}
	return true, nil
}

// postThemeToViews posts the current theme to each view that has a ready document. It runs after the theme changed.
func (s *Surfaces) postThemeToViews() {
	for _, surface := range s.documents.viewSurfaces() {
		if _, err := s.sendToView(surface, map[string]any{"event": "theme", "data": s.Theme()}); err != nil {
			LogError("view channel", err)
		}
	}
}

// viewStoppedEvent returns the payload of the view-stopped event of the view of surface, which has the plugin id and the reason. The
// main page answers it by showing the reason on the card of the surface (docs/spec/native-surfaces.md#view-surfaces).
func viewStoppedEvent(surface, plugin, reason string) map[string]any {
	return map[string]any{"surface": surface, "plugin": plugin, "reason": reason}
}

// ViewCallEvent returns the payload of the view-call event for a call request or a cancel of the view of surface, which has the plugin id.
// A call request is {"id", "command", "params"}; its id is an integer and its command is not empty. A cancel is {"id", "cancel": true}, and
// its payload is {"id", "cancel": true} with the surface and plugin. It returns false when message is neither, and an error for a call
// message whose fields are invalid, including a cancel that is not true or that names a command.
func ViewCallEvent(surface, plugin string, message json.RawMessage) (map[string]any, bool, error) {
	var call struct {
		ID      *uint64         `json:"id"`
		Command *string         `json:"command"`
		Cancel  *bool           `json:"cancel"`
		Params  json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(message, &call); err != nil {
		return nil, false, fmt.Errorf("%s: view message is not an object: %w", surface, err)
	}
	if call.Command == nil && call.Cancel == nil {
		return nil, false, nil
	}
	if call.ID == nil {
		return nil, true, fmt.Errorf("%s: view call has no integer id", surface)
	}
	if call.Cancel != nil {
		if !*call.Cancel || call.Command != nil {
			return nil, true, fmt.Errorf("%s: view call %d cancel must be true and name no command", surface, *call.ID)
		}
		return map[string]any{"surface": surface, "plugin": plugin, "id": *call.ID, "cancel": true}, true, nil
	}
	if call.Command == nil || *call.Command == "" {
		return nil, true, fmt.Errorf("%s: view call %d has an empty command", surface, *call.ID)
	}
	params := call.Params
	if len(params) == 0 {
		params = json.RawMessage(`null`)
	}
	return map[string]any{"surface": surface, "plugin": plugin, "id": *call.ID, "command": *call.Command, "params": params}, true, nil
}

// ViewReplyRequest is the reply of the main page to a call request of the view of Surface. It has a result or an error, not both.
type ViewReplyRequest struct {
	Surface string          `json:"surface"`
	ID      uint64          `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *ViewReplyError `json:"error,omitempty"`
}

// ViewReplyError is the error of a view reply, with the code and the message of the call envelope.
type ViewReplyError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ViewReplyMessage returns the message that the host posts to the view for a reply: {"id", "result"} or {"id", "error"}.
func ViewReplyMessage(req ViewReplyRequest) (map[string]any, error) {
	if len(req.Result) == 0 && req.Error == nil {
		return nil, fmt.Errorf("view reply %d has neither a result nor an error", req.ID)
	}
	if len(req.Result) != 0 && req.Error != nil {
		return nil, fmt.Errorf("view reply %d has both a result and an error", req.ID)
	}
	if req.Error != nil {
		if req.Error.Message == "" {
			return nil, fmt.Errorf("view reply %d has an error without a message", req.ID)
		}
		return map[string]any{"id": req.ID, "error": map[string]any{"code": req.Error.Code, "message": req.Error.Message}}, nil
	}
	return map[string]any{"id": req.ID, "result": req.Result}, nil
}

// replyView posts the reply of the main page to the view of req.Surface through the ready document of the view.
func (s *Surfaces) replyView(req ViewReplyRequest) error {
	message, err := ViewReplyMessage(req)
	if err != nil {
		return err
	}
	return s.postView(req.Surface, message)
}

// ViewEventRequest is the event that the main page pushes to the view of Surface. Event names the subscription and Data is its value,
// which may be any JSON value.
type ViewEventRequest struct {
	Surface string          `json:"surface"`
	Event   string          `json:"event"`
	Data    json.RawMessage `json:"data"`
}

// pushViewEvent posts the event of req to the ready document of its view as {"sok": 1, "event", "data"}. An event without a name or
// without data is refused. A view without a ready document refuses it, and the caller writes that error to the application log.
func (s *Surfaces) pushViewEvent(req ViewEventRequest) error {
	if req.Event == "" {
		return errors.New("view event has an empty event name")
	}
	if len(req.Data) == 0 {
		return fmt.Errorf("view event %s has no data", req.Event)
	}
	return s.postView(req.Surface, map[string]any{"event": req.Event, "data": req.Data})
}

// ViewRequestRequest is the command request that the main page sends to the view of Surface. Params is the params of the command.
type ViewRequestRequest struct {
	Surface string          `json:"surface"`
	ID      uint64          `json:"id"`
	Command string          `json:"command"`
	Params  json.RawMessage `json:"params"`
}

// pushViewRequest posts the command request of req to the ready document of its view as {"sok": 1, "id", "command", "params"}. A request
// has an id and a command; a request without params carries null. A view without a ready document refuses it.
func (s *Surfaces) pushViewRequest(req ViewRequestRequest) error {
	if req.ID == 0 {
		return errors.New("view request has no id")
	}
	if req.Command == "" {
		return fmt.Errorf("view request %d has an empty command", req.ID)
	}
	params := req.Params
	if len(params) == 0 {
		params = json.RawMessage(`null`)
	}
	return s.postView(req.Surface, map[string]any{"id": req.ID, "command": req.Command, "params": params})
}

// ViewReplyEvent returns the payload of the view-reply event for a reply of the view of surface, which has the plugin id. A reply is
// {"reply": id, "result"} or {"reply": id, "error": {"code", "message"}}, and it has exactly one of result and error. It returns false when
// message has no reply field, and an error for a reply whose fields are invalid.
func ViewReplyEvent(surface, plugin string, message json.RawMessage) (map[string]any, bool, error) {
	var reply struct {
		Reply  json.RawMessage `json:"reply"`
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(message, &reply); err != nil {
		return nil, false, fmt.Errorf("%s: view message is not an object: %w", surface, err)
	}
	if len(reply.Reply) == 0 {
		return nil, false, nil
	}
	var id uint64
	if err := json.Unmarshal(reply.Reply, &id); err != nil {
		return nil, true, fmt.Errorf("%s: view reply has no integer id", surface)
	}
	hasResult, hasError := len(reply.Result) > 0, len(reply.Error) > 0
	if hasResult && hasError {
		return nil, true, fmt.Errorf("%s: view reply %d has both a result and an error", surface, id)
	}
	if !hasResult && !hasError {
		return nil, true, fmt.Errorf("%s: view reply %d has neither a result nor an error", surface, id)
	}
	if hasError {
		var failure ViewReplyError
		if err := json.Unmarshal(reply.Error, &failure); err != nil || failure.Message == "" {
			return nil, true, fmt.Errorf("%s: view reply %d has an error without a message", surface, id)
		}
		return map[string]any{"surface": surface, "plugin": plugin, "id": id, "error": failure}, true, nil
	}
	return map[string]any{"surface": surface, "plugin": plugin, "id": id, "result": reply.Result}, true, nil
}
