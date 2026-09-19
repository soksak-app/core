// 페이지가 호출하는 함수와 그 등록.
//
// 메인 페이지는 Wails 서비스로 등록한 Host 의 공개 메서드를 호출한다. 앱이 만든 웹뷰의
// 문서는 bridge.js 가 제공하는 좁은 인터페이스로 invokeNative 의 메서드만 호출한다.

package host

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed bridge.js
var webviewBootstrap string

// backgroundScript 는 스테이징한 프런트엔드의 background.js 다. Run 이 읽는다.
var backgroundScript string

// 아래 메서드는 호출한 창의 Surfaces 에 요청을 전달한다.

func (h *Host) WindowControls(ctx context.Context) (Chrome, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return Chrome{}, err
	}
	return s.WindowChrome()
}

func (h *Host) OverlayShow(ctx context.Context, req OverlayRequest) (Rect, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return Rect{}, err
	}
	return s.OverlayShow(req)
}

func (h *Host) SetShape(ctx context.Context, req ShapeRequest) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.SetShape(req)
}

func (h *Host) ClearShape(ctx context.Context, id string) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.ClearShape(id)
}

func (h *Host) OverlayPlace(ctx context.Context, req PlaceRequest) (Rect, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return Rect{}, err
	}
	return s.OverlayPlace(req)
}

func (h *Host) OverlayHide(ctx context.Context, id string) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.OverlayHide(id)
}

// Report 는 페이지 검사의 한 줄을 로그에 적고 이 창의 진단 기록을 켠 연결에 보낸다. 페이지는
// 파일을 쓸 수 없고, 페이지의 콘솔은 디버거 밖에서 보이지 않는다.
func (h *Host) Report(ctx context.Context, line string) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	log.Println(line)
	s.log(line)
	return nil
}

func (h *Host) SetTheme(ctx context.Context, theme Theme) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.SetTheme(theme)
}

func (h *Host) SyncSurfaces(ctx context.Context, req SyncRequest) (PreparedSurfaces, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return PreparedSurfaces{}, err
	}
	return s.SyncSurfaces(req)
}

func (h *Host) PresentSurfaces(ctx context.Context, req PresentRequest) ([]Placement, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return nil, err
	}
	return s.PresentSurfaces(req)
}

func (h *Host) WaitPresented(ctx context.Context) (float64, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return 0, err
	}
	return s.presented()
}

func (h *Host) OverlayUpdate(ctx context.Context, req UpdateRequest) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	s.OverlayUpdate(req)
	return nil
}

// nativeCall 은 bridge.js 가 보낸 호출 하나다.
type nativeCall struct {
	Epoch  string            `json:"epoch"`
	ID     uint64            `json:"id"`
	Method string            `json:"method"`
	Args   []json.RawMessage `json:"args"`
}

func nativeArgs(call nativeCall, into ...any) error {
	if len(call.Args) != len(into) {
		return fmt.Errorf("%s expects %d arguments", call.Method, len(into))
	}
	for i, target := range into {
		if err := json.Unmarshal(call.Args[i], target); err != nil {
			return err
		}
	}
	return nil
}

// invokeNative 는 네이티브 웹뷰 viewID 의 문서가 호출한 메서드를 실행한다. 추가 문서의
// 인터페이스는 Wails 바인딩과 별개다.
func invokeNative(s *Surfaces, viewID uint64, call nativeCall) (any, error) {
	var id, key, value string
	var instance uint64
	switch call.Method {
	case "ExposureRegister":
		var req SurfaceRegistration
		if err := nativeArgs(call, &req); err != nil {
			return nil, err
		}
		return nil, s.exposureRegister(viewID, req)
	case "ExposureReply":
		var req ExposureReplyRequest
		if err := nativeArgs(call, &req); err != nil {
			return nil, err
		}
		return nil, s.exposureReply(viewID, req)
	case "Theme":
		if err := nativeArgs(call); err != nil {
			return nil, err
		}
		return s.Theme(), nil
	case "SidecarSend":
		var body json.RawMessage
		if err := nativeArgs(call, &key, &id, &body); err != nil {
			return nil, err
		}
		return nil, s.SidecarSend(key, id, body)
	case "CompositionPlace":
		var req CompositionPlaceRequest
		if err := nativeArgs(call, &req); err != nil {
			return nil, err
		}
		return nil, s.placeComposition(viewID, req)
	case "ModalContent", "ModalReady":
		if err := nativeArgs(call, &id, &instance); err != nil {
			return nil, err
		}
		if call.Method == "ModalContent" {
			return s.ModalContent(id, instance), nil
		}
		s.ModalReady(id, instance)
		return nil, nil
	case "DocumentAttach", "DocumentLoad", "DocumentGo", "DocumentDetach":
		var req DocumentRequest
		if err := nativeArgs(call, &req); err != nil {
			return nil, err
		}
		switch call.Method {
		case "DocumentAttach":
			return nil, s.attachDocument(viewID, req)
		case "DocumentLoad":
			return nil, s.loadDocument(viewID, req)
		case "DocumentGo":
			return s.goDocument(viewID, req)
		default:
			return nil, s.detachDocument(viewID, req)
		}
	case "ImageAttach", "ImageFocus", "ImageCaret", "ImageText", "ImageDetach":
		var req ImageRequest
		if err := nativeArgs(call, &req); err != nil {
			return nil, err
		}
		switch call.Method {
		case "ImageAttach":
			return nil, s.attachImage(viewID, req)
		case "ImageFocus":
			return nil, s.focusImage(viewID, req)
		case "ImageCaret":
			var x, y, w, h float64
			if err := nativeArgs(call, &req, &x, &y, &w, &h); err != nil {
				return nil, err
			}
			return nil, s.caretImage(viewID, req, x, y, w, h)
		case "ImageText":
			var text string
			if err := nativeArgs(call, &req, &text); err != nil {
				return nil, err
			}
			return nil, s.textImage(viewID, req, text)
		default:
			return nil, s.detachImage(viewID, req)
		}
	case "OverlayPick":
		if err := nativeArgs(call, &id, &instance, &key, &value); err != nil {
			return nil, err
		}
		return nil, s.OverlayPick(id, instance, key, value)
	default:
		return nil, fmt.Errorf("unknown native call: %s", call.Method)
	}
}

// committedNative 는 네이티브 웹뷰 viewID 가 새 문서를 표시하기 시작했음을 소유 창에 알린다.
func committedNative(viewID uint64) {
	var owner *Surfaces
	application.InvokeSync(func() {
		if view := nativeViews[viewID]; view != nil {
			owner = view.owner
		}
	})
	if owner != nil {
		owner.surfaceCommitted(viewID)
	}
}

// dispatchNative 는 네이티브 웹뷰 viewID 의 메시지를 실행하고 응답을 그 웹뷰에 보낸다.
func dispatchNative(viewID uint64, body string) {
	var call nativeCall
	if err := json.Unmarshal([]byte(body), &call); err != nil {
		log.Printf("native message: %v", err)
		return
	}
	var owner *Surfaces
	application.InvokeSync(func() {
		if view := nativeViews[viewID]; view != nil {
			owner = view.owner
		}
	})
	if owner == nil {
		return
	}
	result, err := invokeNative(owner, viewID, call)
	reply := map[string]any{"epoch": call.Epoch, "id": call.ID, "result": result}
	if err != nil {
		reply["error"] = err.Error()
	}
	data, err := json.Marshal(reply)
	if err != nil {
		log.Printf("native reply: %v", err)
		return
	}
	application.InvokeSync(func() {
		if view := nativeViews[viewID]; view != nil {
			view.execJS("window.__soksakNative?.receive(" + string(data) + ")")
		}
	})
}
