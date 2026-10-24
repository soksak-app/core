// Display, layout, update, hiding, content delivery, ready notification, and pick delivery of native modals.
//
// The page sends the content of a [data-native-modal] element when it opens it. A modal is rendered by another web view added to the
// same window.

package host

import (
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// OverlayRequest holds the values needed to render a [data-native-modal] element in another view.
type OverlayRequest struct {
	Mode      string  `json:"mode"`
	Card      Rect    `json:"card"`
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Rect      Rect    `json:"rect"`
	ClassName string  `json:"className"`
	HTML      string  `json:"html"`
	CSS       string  `json:"css"`
	Border    string  `json:"border"`
	Radius    float64 `json:"radius"`
}

// OverlayContent is the content that a modal view requests after it loads.
type OverlayContent struct {
	Mode      string `json:"mode"`
	Card      Rect   `json:"card"`
	Title     string `json:"title"`
	CSS       string `json:"css"`
	ClassName string `json:"className"`
	HTML      string `json:"html"`
	Border    string `json:"border"`
}

// UpdateRequest is the new content of an open modal. It holds only the values that the page measured from the element. An already open
// modal keeps its position and size.
type UpdateRequest struct {
	ID string `json:"id"`
	OverlayContent
}

// modal is the content that the child modal web view currently draws.
//
// The page shows only one [data-native-modal] element at a time and closes it before showing the next element,
// so one record also holds which modal it is.
type modal struct {
	instance uint64
	// The id of the element. The modal page puts this value in every call, and a call with another id is the last one
	// that a closed modal sent.
	id      string
	content OverlayContent
	// revision rises whenever the content or the position changes. The modal page discards a value older than this.
	revision uint64
	// Tells whether the page finished rendering and started to show the web view. The same display is not done twice.
	shown bool
	// Tells whether the web view was shown and the keyboard focus was handed over. host.window reports this value.
	visible bool
	radius  float64
	// view is the child WebView of this instance. It is created hidden and
	// is closed when this instance is replaced or closed.
	view *nativeWebview
}

// OverlayPick publishes the key and value that the modal page changed. The main page decides the meaning.
func (s *Surfaces) OverlayPick(id string, instance uint64, key string, value string) error {
	s.mu.Lock()
	var open *OpenModal
	if s.modal != nil {
		open = &OpenModal{ID: s.modal.id, Instance: s.modal.instance}
	}
	s.mu.Unlock()
	if fields, dropped := OverlayPickDropped(open, id, instance, key); dropped {
		EmitHost(LevelInfo, "host.overlay.dropped", fields)
		return nil
	}
	s.Emit("overlay-pick", map[string]string{
		"id": id, "key": key, "value": value,
	})
	return nil
}

// OpenModal names the modal that a window shows: the id of its element and its instance.
type OpenModal struct {
	ID       string
	Instance uint64
}

// OverlayPickDropped tells whether the reply of the modal id and instance is dropped because that modal is not the open
// one (a closing modal still sends its last state report), and returns the fields of its record host.overlay.dropped.
func OverlayPickDropped(open *OpenModal, id string, instance uint64, key string) (map[string]any, bool) {
	if open != nil && open.ID == id && open.Instance == instance {
		return nil, false
	}
	shown := ""
	if open != nil {
		shown = open.ID
	}
	return map[string]any{"id": id, "instance": instance, "key": key, "open": shown}, true
}

// OverlayShow renders one shown element in a hidden child web view. The web view is shown after its document
// reports that it finished rendering.
func (s *Surfaces) OverlayShow(req OverlayRequest) (Rect, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return Rect{}, errNoWindow
	}
	s.mu.Lock()
	previous := s.modal
	s.mu.Unlock()
	if previous != nil {
		if err := s.OverlayHide(previous.id); err != nil {
			return Rect{}, fmt.Errorf("close previous modal: %w", err)
		}
	}
	var at Rect
	var alignErr error
	application.InvokeSync(func() { at, alignErr = aligned(win, req.Rect) })
	if alignErr != nil {
		return Rect{}, alignErr
	}
	s.mu.Lock()
	s.nextModal++
	instance := s.nextModal
	s.modal = &modal{
		id: req.ID, instance: instance, revision: 1,
		radius:  req.Radius,
		content: OverlayContent{Mode: req.Mode, Card: req.Card, Title: req.Title, CSS: req.CSS, ClassName: req.ClassName, HTML: req.HTML, Border: req.Border},
	}
	s.mu.Unlock()
	modalURL := "/overlay.html?id=" + url.QueryEscape(req.ID) + "&instance=" + fmt.Sprint(instance)
	view, err := newNativeWebview(s, nativeWebviewOptions{
		URL: modalURL, X: at.X, Y: at.Y, Width: at.W, Height: at.H,
		Hidden: true, Transparent: true, FillParent: true,
		Name: "modal:" + req.ID,
	})
	if err != nil {
		s.mu.Lock()
		if s.modal != nil && s.modal.id == req.ID && s.modal.instance == instance {
			s.modal = nil
		}
		s.mu.Unlock()
		s.setBackground(false)
		return Rect{}, fmt.Errorf("create modal webview: %w", err)
	}
	application.InvokeSync(func() {
		system.ConfigureModal(view.handle, req.Title, req.Radius)
	})
	s.mu.Lock()
	if s.modal == nil || s.modal.id != req.ID || s.modal.instance != instance {
		s.mu.Unlock()
		view.Close()
		return Rect{}, fmt.Errorf("modal instance was replaced while loading")
	}
	s.modal.view = view
	s.mu.Unlock()
	s.Emit("modal-content", ModalContentEvent{ID: req.ID, Instance: instance, Revision: 1,
		Content: OverlayContent{Mode: req.Mode, Card: req.Card, Title: req.Title,
			CSS: req.CSS, ClassName: req.ClassName, HTML: req.HTML, Border: req.Border}})
	return at, nil
}

// PlaceRequest is the new region of an open modal view. The page decides it. Dragging the card handle
// changes the position, and new content changes the size.
type PlaceRequest struct {
	ID   string `json:"id"`
	Rect Rect   `json:"rect"`
	Card Rect   `json:"card"`
}

// OverlayPlace changes the region of the child web view inside the main window.
func (s *Surfaces) OverlayPlace(req PlaceRequest) (Rect, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return Rect{}, errNoWindow
	}
	s.mu.Lock()
	live := s.modal
	if live == nil || live.id != req.ID {
		s.mu.Unlock()
		return Rect{}, nil
	}
	view := live.view
	instance := live.instance
	s.mu.Unlock()
	if view == nil {
		return Rect{}, fmt.Errorf("modal webview is not ready for placement")
	}
	var at Rect
	var alignErr error
	application.InvokeSync(func() {
		at, alignErr = aligned(win, req.Rect)
	})
	if alignErr != nil {
		return Rect{}, alignErr
	}
	view.SetBounds(at.X, at.Y, at.W, at.H)
	s.mu.Lock()
	if s.modal == nil || s.modal.id != req.ID || s.modal.instance != instance {
		s.mu.Unlock()
		return Rect{}, nil
	}
	s.modal.content.Card = req.Card
	s.modal.revision++
	revision := s.modal.revision
	s.mu.Unlock()
	event := map[string]any{"id": req.ID, "instance": instance, "revision": revision, "card": req.Card}
	s.Emit("modal-position", event)
	if err := emitModalEvent(view, "modal-position", event); err != nil {
		return Rect{}, err
	}
	s.windowChanged()
	return at, nil
}

// OverlayHide removes the child web view and returns the keyboard focus to the main web view.
func (s *Surfaces) OverlayHide(id string) error {
	s.mu.Lock()
	if s.modal == nil || s.modal.id != id {
		s.mu.Unlock()
		return nil
	}
	view := s.modal.view
	s.modal = nil
	s.mu.Unlock()
	if view != nil {
		application.InvokeSync(func() { system.FocusModal(view.handle, false) })
		view.Close()
	}
	s.setBackground(false)
	s.windowChanged()
	return nil
}

// discardOverlay removes the modal of the previous main document when a navigation commits. Its DOM and reply
// callbacks are gone, so the native view has no owner.
func (s *Surfaces) discardOverlay() {
	s.mu.Lock()
	var view *nativeWebview
	if s.modal != nil {
		view = s.modal.view
	}
	s.modal = nil
	s.mu.Unlock()
	if view != nil {
		view.Close()
	}
	s.setBackground(false)
}

// OverlayUpdate changes the content of an open modal without recreating the view. A modal whose controls change the page state
// is drawn again while it is open.
func (s *Surfaces) OverlayUpdate(req UpdateRequest) error {
	content := req.OverlayContent
	s.mu.Lock()
	ok := s.modal != nil && s.modal.id == req.ID
	var instance, revision uint64
	var view *nativeWebview
	if ok {
		instance = s.modal.instance
		view = s.modal.view
		s.modal.content = content
		s.modal.revision++
		revision = s.modal.revision
	}
	s.mu.Unlock()
	if !ok {
		return nil
	}
	if view == nil {
		return fmt.Errorf("modal content update without a native webview: %s", req.ID)
	}
	event := ModalContentEvent{ID: req.ID, Instance: instance, Revision: revision, Content: content}
	s.Emit("modal-content", event)
	if err := emitModalEvent(view, "modal-content", event); err != nil {
		return err
	}
	return nil
}

// emitModalEvent delivers an update through the child WebView bridge. A Wails window event is
// limited to the scope of the application WebView, so it cannot update a native child document reliably.
func emitModalEvent(view *nativeWebview, event string, data any) error {
	if view == nil {
		return fmt.Errorf("modal event %s has no native webview", event)
	}
	payload, err := json.Marshal(map[string]any{"event": event, "data": data})
	if err != nil {
		return fmt.Errorf("encode modal event %s: %w", event, err)
	}
	var dispatchErr error
	application.InvokeSync(func() {
		if view.handle != nil {
			view.execJS("window.__soksakNative?.receive(" + string(payload) + ")")
			return
		}
		dispatchErr = fmt.Errorf("modal event %s targets a closed native webview", event)
	})
	return dispatchErr
}

// ModalContentEvent is the new content of one modal that the modal page receives.
type ModalContentEvent struct {
	Instance uint64         `json:"instance"`
	ID       string         `json:"id"`
	Revision uint64         `json:"revision"`
	Content  OverlayContent `json:"content"`
}

// RevisedContent is the content of a modal and the change number of that content.
type RevisedContent struct {
	Revision uint64         `json:"revision"`
	Content  OverlayContent `json:"content"`
}

// holdModalContent is called in a diagnostic build before the modal content reply of window s is sent. When a check
// holds the reply, it does not return until the reply is released. It is nil in other builds.
var holdModalContent func(s *Surfaces)

// ModalContent returns the content that a modal view requested after it loaded. For another modal, it returns empty content with number 0,
// and the modal page discards it.
func (s *Surfaces) ModalContent(id string, instance uint64) RevisedContent {
	var answer RevisedContent
	s.mu.Lock()
	if s.modal != nil && s.modal.id == id && s.modal.instance == instance {
		answer = RevisedContent{Revision: s.modal.revision, Content: s.modal.content}
	}
	s.mu.Unlock()
	if holdModalContent != nil {
		holdModalContent(s)
	}
	return answer
}

// ModalReady reveals this display only once. A notification that a removed document sent late does not reveal a new display of the same
// modal and does not move the focus.
func (s *Surfaces) ModalReady(id string, instance uint64) error {
	s.mu.Lock()
	live := s.modal
	first := live != nil && live.id == id && live.instance == instance && !live.shown
	current := live != nil && live.id == id && live.instance == instance
	dialog := first && live.content.Mode == "dialog"
	view := (*nativeWebview)(nil)
	if first {
		view = live.view
	}
	if first {
		live.shown = true
	}
	s.mu.Unlock()
	if !first {
		if current {
			s.rendered(id)
			return nil
		}
		// A ready request of a modal that is not open came from a document that was removed. It changes nothing and is
		// recorded as a trace event, not as an error (docs/spec/host-contract.md#contract-cases).
		EmitHost(LevelDebug, "host.trace.modal.stale-ready", map[string]any{"modal": id, "instance": instance})
		return nil
	}
	if view == nil {
		return fmt.Errorf("modal ready without a native webview: %s", id)
	}
	s.setBackground(dialog)
	application.InvokeSync(func() {
		system.ConfigureModal(view.handle, live.content.Title, live.radius)
		system.SetWebviewHidden(view.handle, false)
		system.FocusModal(view.handle, true)
	})
	s.mu.Lock()
	if s.modal == live {
		live.visible = true
	}
	s.mu.Unlock()
	s.rendered(id)
	return nil
}

// rendered reports that the modal document finished rendering. Only this notification can confirm whether the updated content reached that document,
// so it is also kept in the diagnostic record.
func (s *Surfaces) rendered(id string) {
	s.Emit("modal-rendered", id)
	s.note("diagnostics: modal rendered " + id)
	s.windowChanged()
}

func (s *Surfaces) dialog() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.modal != nil && s.modal.content.Mode == "dialog"
}

// setBackground tells the main document and the surface documents whether a dialog is open.
func (s *Surfaces) setBackground(enabled bool) {
	if win, ok := s.window, s.window != nil; ok {
		win.ExecJS(fmt.Sprintf("window.__soksakBackground = %t", enabled))
	}
	s.invoke(func() {
		s.setDocumentsBackground(enabled)
	})
}
