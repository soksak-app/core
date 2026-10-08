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

func (h *Host) OverlayShow(ctx context.Context, reqJSON json.RawMessage) (Rect, error) {
	req, err := argument[OverlayRequest]("request", reqJSON)
	if err != nil {
		return Rect{}, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return Rect{}, err
	}
	return s.OverlayShow(req)
}

func (h *Host) SetShape(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[ShapeRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.SetShape(req)
}

func (h *Host) ClearShape(ctx context.Context, idJSON json.RawMessage) error {
	id, err := argument[string]("id", idJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.ClearShape(id)
}

func (h *Host) OverlayPlace(ctx context.Context, reqJSON json.RawMessage) (Rect, error) {
	req, err := argument[PlaceRequest]("request", reqJSON)
	if err != nil {
		return Rect{}, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return Rect{}, err
	}
	return s.OverlayPlace(req)
}

func (h *Host) OverlayHide(ctx context.Context, idJSON json.RawMessage) error {
	id, err := argument[string]("id", idJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.OverlayHide(id)
}

// Report 는 페이지 검사의 한 줄을 로그에 적고 이 창의 진단 기록을 켠 연결에 보낸다. 페이지는
// 파일을 쓸 수 없고, 페이지의 콘솔은 디버거 밖에서 보이지 않는다.
func (h *Host) Report(ctx context.Context, lineJSON json.RawMessage) error {
	line, err := argument[string]("line", lineJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	log.Println(line)
	s.log(line)
	return nil
}

func (h *Host) SetTheme(ctx context.Context, themeJSON json.RawMessage) error {
	theme, err := argument[Theme]("theme", themeJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.SetTheme(theme)
}

// Theme 은 surface theme 갱신을 구독하는 페이지의 실제 appearance 를 반환한다.
func (h *Host) Theme(ctx context.Context) (Theme, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return Theme{}, err
	}
	return s.Theme(), nil
}

func (h *Host) SyncSurfaces(ctx context.Context, reqJSON json.RawMessage) (PreparedSurfaces, error) {
	req, err := argument[SyncRequest]("request", reqJSON)
	if err != nil {
		return PreparedSurfaces{}, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return PreparedSurfaces{}, err
	}
	return s.SyncSurfaces(req)
}

func (h *Host) PresentSurfaces(ctx context.Context, reqJSON json.RawMessage) ([]Placement, error) {
	req, err := argument[PresentRequest]("request", reqJSON)
	if err != nil {
		return nil, err
	}
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

func (h *Host) OverlayUpdate(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[UpdateRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.OverlayUpdate(req)
}

// 메인 페이지의 document, image, composition 호출은 등록된 window ID 를
// 인증된 유일한 메인 호출자 identity 로 사용한다.
func (h *Host) CompositionDeclare(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[CompositionDeclareRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.declareComposition(uint64(s.window.ID()), req)
}

func (h *Host) CompositionPlace(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[CompositionPlaceRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.placeComposition(uint64(s.window.ID()), req)
}

func (h *Host) DocumentAttach(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[DocumentRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.attachDocument(uint64(s.window.ID()), req)
}
func (h *Host) DocumentLoad(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[DocumentRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.loadDocument(uint64(s.window.ID()), req)
}
func (h *Host) DocumentZoom(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[DocumentRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.zoomDocument(uint64(s.window.ID()), req)
}
func (h *Host) DocumentPost(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[DocumentRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.postDocument(uint64(s.window.ID()), req)
}
func (h *Host) DocumentGo(ctx context.Context, reqJSON json.RawMessage) (bool, error) {
	req, err := argument[DocumentRequest]("request", reqJSON)
	if err != nil {
		return false, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return false, err
	}
	return s.goDocument(uint64(s.window.ID()), req)
}
func (h *Host) DocumentDetach(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[DocumentRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.detachDocument(uint64(s.window.ID()), req)
}

func (h *Host) ImageAttach(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[ImageRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return ImageCallError("imageAttach", s.attachImage(uint64(s.window.ID()), req))
}
func (h *Host) ImageFocus(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[ImageRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return ImageCallError("imageFocus", s.focusImage(uint64(s.window.ID()), req))
}
func (h *Host) ImageCaret(ctx context.Context, reqJSON json.RawMessage, xJSON json.RawMessage, yJSON json.RawMessage, wJSON json.RawMessage, hgtJSON json.RawMessage) error {
	req, err := argument[ImageRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	x, err := argument[float64]("x", xJSON)
	if err != nil {
		return err
	}
	y, err := argument[float64]("y", yJSON)
	if err != nil {
		return err
	}
	w, err := argument[float64]("w", wJSON)
	if err != nil {
		return err
	}
	hgt, err := argument[float64]("h", hgtJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return ImageCallError("imageCaret", s.caretImage(uint64(s.window.ID()), req, float64(x), float64(y), float64(w), float64(hgt)))
}
func (h *Host) ImageText(ctx context.Context, reqJSON json.RawMessage, textJSON json.RawMessage) error {
	req, err := argument[ImageRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	text, err := argument[string]("text", textJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return ImageCallError("imageText", s.textImage(uint64(s.window.ID()), req, text))
}
func (h *Host) ImageDetach(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[ImageRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return ImageCallError("imageDetach", s.detachImage(uint64(s.window.ID()), req))
}

// RetainRequest 는 모든 프로젝트 레이아웃이 가진 표면 목록이다.
type RetainRequest struct {
	Surfaces []RetainedSurface `json:"surfaces"`
}

// RetainResult 는 영속 서비스가 닫은 세션 수다.
type RetainResult struct {
	Closed int `json:"closed"`
}

// SidecarsRetain 은 영속 사이드카 서비스에서 어떤 레이아웃에도 없는 표면의 세션을 닫는다
// (docs/spec/terminal-runtime.md).
func (h *Host) SidecarsRetain(ctx context.Context, reqJSON json.RawMessage) (RetainResult, error) {
	req, err := argument[RetainRequest]("request", reqJSON)
	if err != nil {
		return RetainResult{}, err
	}
	if _, err := h.surface(ctx); err != nil {
		return RetainResult{}, err
	}
	closed, err := h.sidecars.Retain(req.Surfaces)
	return RetainResult{Closed: closed}, err
}

func (h *Host) SidecarSend(ctx context.Context, nameJSON json.RawMessage, surfaceJSON json.RawMessage, body json.RawMessage) error {
	name, err := argument[string]("sidecar", nameJSON)
	if err != nil {
		return err
	}
	surface, err := argument[string]("surface", surfaceJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.sidecarSendFrom(uint64(s.window.ID()), name, surface, body)
}

// nativeCall 은 bridge.js 가 보낸 호출 하나다.
type nativeCall struct {
	Epoch  string            `json:"epoch"`
	ID     uint64            `json:"id"`
	Method string            `json:"method"`
	Args   []json.RawMessage `json:"args"`
}

// nativeArg 는 native 호출 인자 하나의 이름과 해석할 자리다.
type nativeArg struct {
	name string
	into any
}

// nativeArgs 는 call 의 인자를 args 의 순서대로 해석한다. 보내지 않은 인자는 null 이다
// (docs/spec/native-host.md#host-calls).
func nativeArgs(call nativeCall, args ...nativeArg) error {
	if len(call.Args) > len(args) {
		return fmt.Errorf("%s takes %d arguments, not %d", call.Method, len(args), len(call.Args))
	}
	for i, arg := range args {
		raw := json.RawMessage("null")
		if i < len(call.Args) {
			raw = call.Args[i]
		}
		if err := decodeArgument(arg.name, raw, arg.into); err != nil {
			return err
		}
	}
	return nil
}

// InvokeNative 는 네이티브 웹뷰 viewID 의 문서가 method 를 args 로 호출한 것처럼 실행한다. 검사가 native 호출의 인자
// 해석을 이 함수로 확인한다.
func InvokeNative(s *Surfaces, viewID uint64, method string, args []json.RawMessage) (any, error) {
	return invokeNative(s, viewID, nativeCall{Method: method, Args: args})
}

// invokeNative 는 네이티브 웹뷰 viewID 의 문서가 호출한 메서드를 실행한다. 추가 문서의
// 인터페이스는 Wails 바인딩과 별개다.
func invokeNative(s *Surfaces, viewID uint64, call nativeCall) (any, error) {
	var id, key, value string
	var instance uint64
	switch call.Method {
	case "ExposureRegister":
		var req SurfaceRegistration
		if err := nativeArgs(call, nativeArg{"request", &req}); err != nil {
			return nil, err
		}
		return nil, s.exposureRegister(viewID, req)
	case "Theme":
		if err := nativeArgs(call); err != nil {
			return nil, err
		}
		return s.Theme(), nil
	case "SidecarSend":
		var body json.RawMessage
		if err := nativeArgs(call, nativeArg{"sidecar", &key}, nativeArg{"surface", &id}, nativeArg{"body", &body}); err != nil {
			return nil, err
		}
		return nil, s.sidecarSendFrom(viewID, key, id, body)
	case "CompositionDeclare":
		var req CompositionDeclareRequest
		if err := nativeArgs(call, nativeArg{"request", &req}); err != nil {
			return nil, err
		}
		return nil, s.declareComposition(viewID, req)
	case "CompositionPlace":
		var req CompositionPlaceRequest
		if err := nativeArgs(call, nativeArg{"request", &req}); err != nil {
			return nil, err
		}
		return nil, s.placeComposition(viewID, req)
	case "ModalContent", "ModalReady":
		if err := nativeArgs(call, nativeArg{"id", &id}, nativeArg{"instance", &instance}); err != nil {
			return nil, err
		}
		if call.Method == "ModalContent" {
			return s.ModalContent(id, instance), nil
		}
		return nil, s.ModalReady(id, instance)
	case "DocumentAttach", "DocumentLoad", "DocumentZoom", "DocumentGo", "DocumentPost", "DocumentDetach":
		var req DocumentRequest
		if err := nativeArgs(call, nativeArg{"request", &req}); err != nil {
			return nil, err
		}
		switch call.Method {
		case "DocumentAttach":
			return nil, s.attachDocument(viewID, req)
		case "DocumentLoad":
			return nil, s.loadDocument(viewID, req)
		case "DocumentZoom":
			return nil, s.zoomDocument(viewID, req)
		case "DocumentGo":
			return s.goDocument(viewID, req)
		case "DocumentPost":
			return nil, s.postDocument(viewID, req)
		default:
			return nil, s.detachDocument(viewID, req)
		}
	case "ImageAttach", "ImageFocus", "ImageDetach":
		var req ImageRequest
		if err := nativeArgs(call, nativeArg{"request", &req}); err != nil {
			return nil, err
		}
		switch call.Method {
		case "ImageAttach":
			return nil, ImageCallError("imageAttach", s.attachImage(viewID, req))
		case "ImageFocus":
			return nil, ImageCallError("imageFocus", s.focusImage(viewID, req))
		default:
			return nil, ImageCallError("imageDetach", s.detachImage(viewID, req))
		}
	case "ImageCaret":
		var req ImageRequest
		var x, y, w, h float64
		if err := nativeArgs(call, nativeArg{"request", &req}, nativeArg{"x", &x}, nativeArg{"y", &y}, nativeArg{"w", &w}, nativeArg{"h", &h}); err != nil {
			return nil, err
		}
		return nil, ImageCallError("imageCaret", s.caretImage(viewID, req, x, y, w, h))
	case "ImageText":
		var req ImageRequest
		var text string
		if err := nativeArgs(call, nativeArg{"request", &req}, nativeArg{"text", &text}); err != nil {
			return nil, err
		}
		return nil, ImageCallError("imageText", s.textImage(viewID, req, text))
	case "OverlayPick":
		if err := nativeArgs(call, nativeArg{"id", &id}, nativeArg{"instance", &instance}, nativeArg{"key", &key}, nativeArg{"value", &value}); err != nil {
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
		LogError("native message", err)
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
		LogError("native reply", err)
		return
	}
	application.InvokeSync(func() {
		if view := nativeViews[viewID]; view != nil {
			view.execJS("window.__soksakNative?.receive(" + string(data) + ")")
		}
	})
}
