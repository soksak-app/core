// 네이티브 모달의 표시, 배치, 갱신, 숨김, 내용 전달, 준비 알림과 선택 전달.
//
// 페이지는 [data-native-modal] 요소를 열 때 그 내용을 보낸다. 모달은 같은 창에 추가한
// 다른 웹뷰가 렌더링한다.

package host

import (
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
	// 페이지가 렌더링을 마쳐 웹뷰를 표시했는지 나타낸다.
	shown bool
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
		id: req.ID, instance: instance,
		content: OverlayContent{Mode: req.Mode, Card: req.Card, Title: req.Title, CSS: req.CSS, ClassName: req.ClassName, HTML: req.HTML, Border: req.Border},
	}
	s.mu.Unlock()
	view, err := newNativeWebview(s, nativeWebviewOptions{
		URL: "about:blank", Hidden: true, Transparent: true,
		FillParent: req.Mode == "dialog",
		X:          at.X, Y: at.Y, Width: at.W, Height: at.H,
	})
	if err != nil {
		s.mu.Lock()
		s.modal = nil
		s.mu.Unlock()
		return Rect{}, err
	}
	application.InvokeSync(func() { system.ConfigureModal(view.NativeView(), req.Title, req.Radius) })
	s.mu.Lock()
	s.modalView = view
	s.mu.Unlock()
	// ModalReady 를 호출할 수 있는 문서를 시작하기 전에 뷰를 기록한다.
	err = view.SetURL(fmt.Sprintf("overlay.html?id=%s&instance=%d", url.QueryEscape(req.ID), instance))
	if err != nil {
		_ = s.OverlayHide(req.ID)
		return Rect{}, err
	}
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
	live, view := s.modal, s.modalView
	held := live != nil && live.id == req.ID && view != nil
	s.mu.Unlock()
	if !held {
		return Rect{}, nil
	}
	var at Rect
	application.InvokeSync(func() {
		at = aligned(win, req.Rect)
		view.SetBounds(at.X, at.Y, at.W, at.H)
	})
	s.mu.Lock()
	live.content.Card = req.Card
	s.mu.Unlock()
	s.Emit("modal-position", map[string]any{"id": req.ID, "instance": live.instance, "card": req.Card})
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
	view := s.modalView
	s.modal, s.modalView = nil, nil
	s.mu.Unlock()
	s.setBackground(false)
	if view != nil {
		application.InvokeSync(func() { system.FocusModal(view.NativeView(), false) })
		view.Close()
	}
	s.windowChanged()
	return nil
}

// discardOverlay 는 탐색이 커밋될 때 이전 메인 문서의 모달을 제거한다. 그 DOM 과 응답
// 콜백이 사라졌으므로 네이티브 뷰의 소유자가 없다.
func (s *Surfaces) discardOverlay() {
	s.mu.Lock()
	view := s.modalView
	s.modal, s.modalView = nil, nil
	s.mu.Unlock()
	s.setBackground(false)
	if view != nil {
		view.Close()
	}
}

// OverlayUpdate 는 뷰를 다시 만들지 않고 열린 모달의 내용을 바꾼다. 컨트롤이 페이지 상태를
// 바꾸는 모달은 열린 동안 다시 그려진다.
func (s *Surfaces) OverlayUpdate(req UpdateRequest) {
	content := req.OverlayContent
	s.mu.Lock()
	ok := s.modal != nil && s.modal.id == req.ID
	var instance uint64
	if ok {
		instance = s.modal.instance
		s.modal.content = content
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	s.Emit("modal-content", ModalContentEvent{ID: req.ID, Instance: instance, Content: content})
}

// ModalContentEvent 는 모달 페이지가 받는 모달 하나의 새 내용이다.
type ModalContentEvent struct {
	Instance uint64         `json:"instance"`
	ID       string         `json:"id"`
	Content  OverlayContent `json:"content"`
}

// ModalContent 는 모달 뷰가 로드한 뒤 요청한 내용을 반환한다.
func (s *Surfaces) ModalContent(id string, instance uint64) OverlayContent {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.modal != nil && s.modal.id == id && s.modal.instance == instance {
		return s.modal.content
	}
	return OverlayContent{}
}

// ModalReady 는 이번 표시를 한 번만 드러낸다. 제거된 문서가 늦게 보낸 알림은 같은
// 모달의 새 표시를 드러내거나 초점을 옮기지 않는다.
func (s *Surfaces) ModalReady(id string, instance uint64) {
	s.mu.Lock()
	live, view := s.modal, s.modalView
	first := live != nil && live.id == id && live.instance == instance && !live.shown && view != nil
	current := live != nil && live.id == id && live.instance == instance
	dialog := first && live.content.Mode == "dialog"
	if first {
		live.shown = true
	}
	s.mu.Unlock()
	if !first {
		if current {
			s.rendered(id)
		}
		return
	}
	application.InvokeSync(func() {
		s.setBackground(dialog)
		view.SetHidden(false)
		system.FocusModal(view.NativeView(), true)
	})
	s.rendered(id)
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
		for _, view := range s.views {
			view.setBackground(enabled)
		}
	})
}
