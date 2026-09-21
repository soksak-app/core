// 네이티브 모달의 표시, 배치, 갱신, 숨김, 내용 전달, 준비 알림과 선택 전달.
//
// 페이지는 [data-native-modal] 요소를 열 때 그 내용을 보낸다. 모달은 같은 창에 추가한
// 다른 웹뷰가 렌더링한다.

package host

import (
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// OverlayRequest 는 [data-native-modal] 요소를 다른 뷰에서 렌더링하는 데 필요한 값이다.
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

// OverlayContent 는 모달 뷰가 로드한 뒤 요청하는 내용이다.
type OverlayContent struct {
	Mode      string `json:"mode"`
	Card      Rect   `json:"card"`
	Title     string `json:"title"`
	CSS       string `json:"css"`
	ClassName string `json:"className"`
	HTML      string `json:"html"`
	Border    string `json:"border"`
}

// UpdateRequest 는 열린 모달의 새 내용이다. 페이지가 요소에서 잰 값만 담는다. 이미 열린
// 모달은 위치와 크기를 유지한다.
type UpdateRequest struct {
	ID string `json:"id"`
	OverlayContent
}

// modal 은 자식 모달 웹뷰가 지금 그리는 내용이다.
//
// 페이지는 [data-native-modal] 요소를 한 번에 하나만 표시하고 다음 요소를 표시하기 전에
// 닫으므로, 기록 하나에 어느 모달인지를 함께 둔다.
type modal struct {
	instance uint64
	// 요소의 id. 모달 페이지는 모든 호출에 이 값을 넣고, 다른 id 의 호출은 닫힌 모달이
	// 마지막으로 보낸 것이다.
	id      string
	content OverlayContent
	// revision 은 내용이나 위치를 바꿀 때마다 오른다. 모달 페이지는 이보다 오래된 값을 버린다.
	revision uint64
	// 페이지가 렌더링을 마쳐 웹뷰 표시를 시작했는지 나타낸다. 같은 표시를 두 번 하지 않는다.
	shown bool
	// 웹뷰를 표시하고 키보드 초점을 넘겼는지 나타낸다. host.window 가 이 값을 보고한다.
	visible bool
	radius  float64
	// view is the child WebView for this instance. It is created hidden and is
	// closed when this instance is replaced or dismissed.
	view *nativeWebview
}

// OverlayPick 은 모달 페이지가 바꾼 키와 값을 발행한다. 의미는 메인 페이지가 결정한다.
func (s *Surfaces) OverlayPick(id string, instance uint64, key string, value string) error {
	s.mu.Lock()
	current := s.modal != nil && s.modal.id == id && s.modal.instance == instance
	s.mu.Unlock()
	if current {
		s.Emit("overlay-pick", map[string]string{
			"id": id, "key": key, "value": value,
		})
	}
	return nil
}

// OverlayShow 는 표시된 요소 하나를 숨긴 자식 웹뷰에서 렌더링한다. 웹뷰는 자기 문서가
// 렌더링을 마쳤다고 알린 뒤에 표시된다.
func (s *Surfaces) OverlayShow(req OverlayRequest) (Rect, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return Rect{}, errNoWindow
	}
	s.mu.Lock()
	previous := s.modal
	s.mu.Unlock()
	if previous != nil {
		_ = s.OverlayHide(previous.id)
	}
	var at Rect
	application.InvokeSync(func() { at = aligned(win, req.Rect) })
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

// PlaceRequest 는 열린 모달 뷰의 새 영역이다. 페이지가 결정한다. 카드 손잡이를 끌면
// 위치가 바뀌고 새 내용은 크기를 바꾼다.
type PlaceRequest struct {
	ID   string `json:"id"`
	Rect Rect   `json:"rect"`
	Card Rect   `json:"card"`
}

// OverlayPlace 는 메인 창 안에서 자식 웹뷰의 영역을 바꾼다.
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
	application.InvokeSync(func() {
		at = aligned(win, req.Rect)
	})
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

// OverlayHide 는 자식 웹뷰를 제거하고 키보드 초점을 메인 웹뷰로 되돌린다.
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

// discardOverlay 는 탐색이 커밋될 때 이전 메인 문서의 모달을 제거한다. 그 DOM 과 응답
// 콜백이 사라졌으므로 네이티브 뷰의 소유자가 없다.
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

// OverlayUpdate 는 뷰를 다시 만들지 않고 열린 모달의 내용을 바꾼다. 컨트롤이 페이지 상태를
// 바꾸는 모달은 열린 동안 다시 그려진다.
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

// emitModalEvent delivers an update through the child WebView bridge. Wails window events are
// scoped to the application WebView, so they cannot update a native child document reliably.
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

// ModalContentEvent 는 모달 페이지가 받는 모달 하나의 새 내용이다.
type ModalContentEvent struct {
	Instance uint64         `json:"instance"`
	ID       string         `json:"id"`
	Revision uint64         `json:"revision"`
	Content  OverlayContent `json:"content"`
}

// RevisedContent 는 모달의 내용과 그 내용의 변경 번호다.
type RevisedContent struct {
	Revision uint64         `json:"revision"`
	Content  OverlayContent `json:"content"`
}

// holdModalContent 는 진단 빌드에서 창 s 의 모달 내용 응답을 보내기 전에 호출된다. 검사가
// 응답을 붙잡았으면 놓을 때까지 반환하지 않는다. 다른 빌드에서는 nil 이다.
var holdModalContent func(s *Surfaces)

// ModalContent 는 모달 뷰가 로드한 뒤 요청한 내용을 반환한다. 다른 모달이면 번호 0 의 빈
// 내용을 반환하고, 모달 페이지는 그것을 버린다.
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

// ModalReady 는 이번 표시를 한 번만 드러낸다. 제거된 문서가 늦게 보낸 알림은 같은
// 모달의 새 표시를 드러내거나 초점을 옮기지 않는다.
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
		}
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

// rendered 는 모달 문서가 렌더링을 마쳤음을 알린다. 갱신된 내용이 그 문서에 도달했는지는
// 이 알림으로만 확인할 수 있으므로 진단 기록에도 남긴다.
func (s *Surfaces) rendered(id string) {
	s.Emit("modal-rendered", id)
	s.log("diagnostics: modal rendered " + id)
	s.windowChanged()
}

func (s *Surfaces) dialog() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.modal != nil && s.modal.content.Mode == "dialog"
}

// setBackground 는 대화 상자가 열렸는지를 메인 문서와 표면 문서에 알린다.
func (s *Surfaces) setBackground(enabled bool) {
	if win, ok := s.window, s.window != nil; ok {
		win.ExecJS(fmt.Sprintf("window.__soksakBackground = %t", enabled))
	}
	application.InvokeSync(func() {
		s.setDocumentsBackground(enabled)
	})
}
