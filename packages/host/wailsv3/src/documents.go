package host

// 표면 페이지 안의 문서 영역. docs/spec/native-surfaces.md 의 "문서 영역"이다.
//
// 표면 페이지가 자기 요소 하나에 외부 문서를 붙인다. 호스트는 그 표면 웹뷰 안에 문서 웹뷰를 두고,
// 페이지가 알린 여백으로 배치하며, 문서 상태를 그 표면에만 보낸다. 문서 웹뷰는 표면 웹뷰의 하위
// 뷰이므로 표면과 함께 옮겨지고 숨겨진다. 표면이 제거되거나 표면 페이지가 다시 읽히면 닫는다.

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

// documentData 는 문서 영역의 영구 사이트 데이터를 두는 설정 디렉터리 안의 디렉터리다. 앱 문서의
// 저장소와 다르다(docs/spec/native-surfaces.md#document-regions).
const documentData = "document-data"

var documentName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// DocumentRequest 는 표면 페이지의 문서 영역 호출이다. 필드는 호출마다 필요한 것만 쓴다.
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

// ZoomFactor 는 문서의 글자 배율이다(docs/spec/text-size.md). 없거나 유한한 양수가 아니면 오류다.
func (r DocumentRequest) ZoomFactor() (float64, error) {
	if r.Zoom == nil || math.IsNaN(*r.Zoom) || math.IsInf(*r.Zoom, 0) || *r.Zoom <= 0 {
		return 0, fmt.Errorf("document zoom must be a finite positive number")
	}
	return *r.Zoom, nil
}

// DocumentState 는 document-state 이벤트의 값이다.
type DocumentState struct {
	Surface  string          `json:"surface"`
	Document string          `json:"document"`
	State    json.RawMessage `json:"state"`
}

// DocumentKey 는 표면과 문서 이름의 쌍이다.
type DocumentKey struct {
	Surface, Name string
}

// CheckDocument 는 표면 호출자의 surface 소유권을 확인하고 키를 반환한다.
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

// Documents 는 창의 문서 영역이다. 값은 문서 웹뷰이고, 만드는 중인 영역은 nil 이다.
type Documents struct {
	mu      sync.Mutex
	handles map[DocumentKey]unsafe.Pointer
}

func NewDocuments() *Documents { return &Documents{handles: map[DocumentKey]unsafe.Pointer{}} }

// Reserve 는 이름을 차지한다. 같은 이름이 이미 있으면 오류다.
func (d *Documents) Reserve(key DocumentKey) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.handles[key]; ok {
		return fmt.Errorf("document %q is already attached", key.Name)
	}
	d.handles[key] = nil
	return nil
}

// Set 은 차지한 이름에 만든 문서를 적는다. 그 사이에 이름이 제거되었으면 false 다.
func (d *Documents) Set(key DocumentKey, handle unsafe.Pointer) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.handles[key]; !ok {
		return false
	}
	d.handles[key] = handle
	return true
}

// Get 은 만들어진 문서를 반환한다.
func (d *Documents) Get(key DocumentKey) (unsafe.Pointer, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if handle := d.handles[key]; handle != nil {
		return handle, nil
	}
	return nil, fmt.Errorf("document %q is not attached", key.Name)
}

// Remove 는 이름을 제거하고 그 문서를 반환한다. 만드는 중이던 이름이면 nil 이다.
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

// RemoveSurface 는 표면의 이름을 모두 제거하고 만들어진 문서를 반환한다.
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

// Names 는 만들어진 문서의 주소별 키다.
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

// All 은 만들어진 문서다.
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

// DocumentGoAction 은 go 요청의 동작 번호와 거리를 반환한다. entry 는 0 이 아닌 offset 이 필요하고
// 다른 동작은 offset 을 받지 않는다.
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

// attachDocument 는 표면 안에 숨긴 문서 영역을 만든다. 같은 이름이 이미 있으면 오류다.
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
	// 만드는 동안 표면이 제거되었으면 만든 문서를 닫는다. 등록과 닫기는 UI 스레드에서 한다.
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

// documentChanged 는 문서 상태를 소유 표면에만 보내고 host.window 감시자에게 알린다. UI 스레드에서 호출된다.
func (s *Surfaces) documentChanged(key DocumentKey, state string) {
	payload := DocumentState{Surface: key.Surface, Document: key.Name, State: json.RawMessage(state)}
	s.emitToSurface(key.Surface, "document-state", payload)
	s.windowChanged()
}

// documentMessage sends a message of a plugin document to the owning surface, or writes its failure to the
// application log. UI 스레드에서 호출된다.
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

// withDocument 는 열린 문서 영역에 대해 UI 스레드에서 run 을 실행한다.
func (s *Surfaces) withDocument(viewID uint64, req DocumentRequest, run func(handle unsafe.Pointer) error) error {
	key, err := s.checkDocument(viewID, req)
	if err != nil {
		return err
	}
	if err := s.requireRegion(key.Surface, key.Name, "document", ""); err != nil {
		return err
	}
	// 조회와 사용을 UI 스레드의 한 작업에서 한다. 닫기도 UI 스레드에서 등록 해제와 함께 일어나므로,
	// 조회한 핸들은 이 작업 동안 해제되지 않는다.
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

// zoomDocument 는 문서의 페이지 확대를 글자 배율로 정한다.
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

// goDocument 는 기록 이동, 기록 항목 열기, 다시 읽기, 멈춤을 실행하고 실행했는지 반환한다.
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
	// 등록 해제와 닫기를 UI 스레드의 한 작업에서 한다. 사이에 다른 작업이 핸들을 쓰지 않는다.
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

// closeSurfaceDocuments 는 표면의 문서 영역을 모두 닫는다. UI 스레드에서 호출한다.
func (s *Surfaces) closeSurfaceDocuments(surface string) {
	handles := s.documents.RemoveSurface(surface)
	for _, handle := range handles {
		system.CloseDocument(handle)
	}
	if len(handles) > 0 {
		s.windowChanged()
	}
}

// surfaceCommitted 는 표면 페이지가 새 문서를 표시하기 시작했을 때 이전 문서와 그림 영역의 등록과 정리를 한다.
// 새 문서는 자기 항목과 문서 영역을 다시 만든다.
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

// setDocumentsBackground 는 대화 상자가 열린 동안 문서 영역을 흐리게 표시한다. UI 스레드에서 호출한다.
func (s *Surfaces) setDocumentsBackground(enabled bool) {
	for _, handle := range s.documents.All() {
		system.SetDocumentBackground(handle, enabled)
	}
}

// 이벤트는 앱 DOM으로 보내며 모듈의 수신기가 payload의 surface 소유자를 확인한다.
func (s *Surfaces) emitToSurface(surface, name string, data any) {
	if s.views[surface] == nil {
		LogInfo("document", fmt.Sprintf("native event %s of closed surface %q arrived after the surface closed", name, surface))
		return
	}
	s.window.EmitEvent(name, data)
}

// imageChanged 는 그림 영역 이벤트를 소유 표면에만 보내고 host.window 감시자에게 알린다. UI 스레드에서 호출된다.
func (s *Surfaces) imageChanged(key ImageKey, event string) {
	payload := map[string]any{"surface": key.Surface, "name": key.Name, "event": json.RawMessage(event)}
	s.emitToSurface(key.Surface, "image-event", payload)
	s.windowChanged()
}

// attachImage 는 표면 안에 숨긴 그림 영역을 만든다. 같은 이름이 이미 있으면 오류다.
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
	// 만드는 동안 표면이 제거되었으면 만든 그림 영역을 닫는다. 등록과 닫기는 UI 스레드에서 한다.
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

// withImage 는 열린 그림 영역에 대해 UI 스레드에서 run 을 실행한다.
func (s *Surfaces) withImage(viewID uint64, req ImageRequest, run func(handle unsafe.Pointer) error) error {
	key, err := s.checkImage(viewID, req)
	if err != nil {
		return err
	}
	if err := s.requireRegion(key.Surface, key.Name, "image", ""); err != nil {
		return err
	}
	// 조회와 사용을 UI 스레드의 한 작업에서 한다. 닫기도 UI 스레드에서 등록 해제와 함께 일어나므로,
	// 조회한 핸들은 이 작업 동안 해제되지 않는다.
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

// closeSurfaceImages 는 표면의 그림 영역을 모두 닫는다. UI 스레드에서 호출한다.
func (s *Surfaces) closeSurfaceImages(surface string) {
	s.images.CloseSurface(surface, func(handle unsafe.Pointer) {
		system.CloseImage(handle)
	})
	// 영역 변경을 알린다.
}

func (s *Surfaces) detachImage(viewID uint64, req ImageRequest) error {
	key, err := s.checkImage(viewID, req)
	if err != nil {
		return err
	}
	// 등록 해제와 닫기를 UI 스레드의 한 작업에서 한다. 사이에 다른 작업이 핸들을 쓰지 않는다.
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
