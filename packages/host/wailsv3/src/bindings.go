// The functions that the page calls and their registration.
//
// The main page calls the public methods of Host, which is registered as a Wails service. The document
// of a web view that the application created calls only the methods of invokeNative, through the narrow interface that bridge.js provides.

package host

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed bridge.js
var webviewBootstrap string

// backgroundScript is the background.js of the staged frontend. Run reads it.
var backgroundScript string

// The methods below forward the request to the Surfaces of the calling window.

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

// Theme returns the actual appearance to a page that subscribes to surface theme updates.
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

// The document, image and composition calls of the main page use the registered window ID
// as the identity of the only authenticated main caller.
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

// ViewReply receives the reply of the main page to a call request of a view (docs/spec/native-surfaces.md#view-surfaces).
func (h *Host) ViewReply(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[ViewReplyRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.replyView(req)
}

// ViewRequest receives a command request that the main page sends to the view of the request (docs/spec/native-surfaces.md#view-surfaces).
func (h *Host) ViewRequest(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[ViewRequestRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.pushViewRequest(req)
}

// ViewEvent receives an event that the main page pushes to the view of the request (docs/spec/native-surfaces.md#view-surfaces).
func (h *Host) ViewEvent(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[ViewEventRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.pushViewEvent(req)
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

// DocumentQuery answers the media, capture and form state of a document region (docs/spec/plugins.md#memory-saver).
func (h *Host) DocumentQuery(ctx context.Context, reqJSON json.RawMessage) (DocumentReport, error) {
	req, err := argument[DocumentRequest]("request", reqJSON)
	if err != nil {
		return DocumentReport{}, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return DocumentReport{}, err
	}
	return s.queryDocument(uint64(s.window.ID()), req)
}

// DocumentInteractionState returns the interactionState of a document region as base64.
func (h *Host) DocumentInteractionState(ctx context.Context, reqJSON json.RawMessage) (string, error) {
	req, err := argument[DocumentRequest]("request", reqJSON)
	if err != nil {
		return "", err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return "", err
	}
	return s.documentInteractionState(uint64(s.window.ID()), req)
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

func (h *Host) DocumentSubscribe(ctx context.Context, reqJSON json.RawMessage) (DocumentSubscription, error) {
	req, err := argument[DocumentRequest]("request", reqJSON)
	if err != nil {
		return DocumentSubscription{}, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return DocumentSubscription{}, err
	}
	handle, err := s.subscribeDocument(uint64(s.window.ID()), req)
	return DocumentSubscription{Handle: handle}, err
}
func (h *Host) DocumentUnsubscribe(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[DocumentRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.unsubscribeDocument(uint64(s.window.ID()), req)
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

// RetainRequest is the list of surfaces that every project layout holds.
type RetainRequest struct {
	Surfaces []RetainedSurface `json:"surfaces"`
}

// RetainResult is the number of sessions that the persistent service closed.
type RetainResult struct {
	Closed int `json:"closed"`
}

// SidecarsRetain closes, in the persistent sidecar service, the sessions of surfaces that no layout holds
// (docs/spec/persistent-services.md).
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

// SidecarsOutdated returns the outdated persistent services (docs/spec/installation.md).
func (h *Host) SidecarsOutdated(ctx context.Context) ([]OutdatedSidecar, error) {
	if _, err := h.surface(ctx); err != nil {
		return nil, err
	}
	return h.sidecars.Outdated(), nil
}

// ReplaceRequest names the sidecar whose outdated service the page asks the host to replace.
type ReplaceRequest struct {
	Sidecar string `json:"sidecar"`
}

// SidecarsReplace replaces the outdated persistent service of a sidecar (docs/spec/persistent-services.md#updates).
// It waits for the service, so the call can take as long as the stop timeout.
func (h *Host) SidecarsReplace(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[ReplaceRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	if _, err := h.surface(ctx); err != nil {
		return err
	}
	return h.sidecars.Replace(ctx, req.Sidecar)
}

func (h *Host) SidecarSend(ctx context.Context, nameJSON json.RawMessage, surfaceJSON json.RawMessage, body json.RawMessage, cidsJSON json.RawMessage) error {
	name, err := argument[string]("sidecar", nameJSON)
	if err != nil {
		return err
	}
	surface, err := argument[string]("surface", surfaceJSON)
	if err != nil {
		return err
	}
	cids, err := argument[[]string]("cids", cidsJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.sidecarSendFrom(uint64(s.window.ID()), name, surface, body, cids)
}

// nativeCall is one call that bridge.js sent.
type nativeCall struct {
	Epoch  string            `json:"epoch"`
	ID     uint64            `json:"id"`
	Method string            `json:"method"`
	Args   []json.RawMessage `json:"args"`
}

// nativeArg is the name of one argument of a native call and the destination it decodes into.
type nativeArg struct {
	name string
	into any
}

// nativeArgs decodes the arguments of call in the order of args. An argument that was not sent is null
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

// InvokeNative runs method with args as if the document of the native web view viewID had called it. The check verifies the argument decoding of native
// calls through this function.
func InvokeNative(s *Surfaces, viewID uint64, method string, args []json.RawMessage) (any, error) {
	return invokeNative(s, viewID, nativeCall{Method: method, Args: args})
}

// invokeNative runs the method that the document of the native web view viewID called. The interface of an additional document
// is separate from the Wails bindings.
func invokeNative(s *Surfaces, viewID uint64, call nativeCall) (result any, err error) {
	started := time.Now()
	returned := false
	defer func() { recordBindingCall(snakeName(call.Method), call.Args, started, err, returned, nil) }()
	result, err = runNative(s, viewID, call)
	returned = true
	return result, err
}

func runNative(s *Surfaces, viewID uint64, call nativeCall) (any, error) {
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
		var cids []string
		if err := nativeArgs(call, nativeArg{"sidecar", &key}, nativeArg{"surface", &id}, nativeArg{"body", &body}, nativeArg{"cids", &cids}); err != nil {
			return nil, err
		}
		return nil, s.sidecarSendFrom(viewID, key, id, body, cids)
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
	case "DocumentAttach", "DocumentLoad", "DocumentZoom", "DocumentGo", "DocumentPost", "DocumentDetach", "DocumentSubscribe", "DocumentUnsubscribe":
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
		case "DocumentSubscribe":
			handle, err := s.subscribeDocument(viewID, req)
			return DocumentSubscription{Handle: handle}, err
		case "DocumentUnsubscribe":
			return nil, s.unsubscribeDocument(viewID, req)
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

// committedNative notifies the owning window that the native web view viewID started to show a new document.
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

// terminatedNative removes the stream subscriptions of the surface of the native web view viewID, whose WebContent process ended, and turns
// off the streams that lose their last subscriber. It runs outside the UI thread.
func terminatedNative(viewID uint64) {
	var owner *Surfaces
	application.InvokeSync(func() {
		if view := nativeViews[viewID]; view != nil {
			owner = view.owner
		}
	})
	if owner != nil {
		owner.surfaceTerminated(viewID)
	}
}

// dispatchNative runs the message of the native web view viewID and sends the reply to that web view.
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
