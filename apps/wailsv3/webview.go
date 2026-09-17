package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed webview_bridge.js
var webviewBootstrap string

//go:embed frontend/background.js
var backgroundScript string

type nativeWebviewOptions struct {
	URL                 string
	X, Y, Width, Height float64
	Hidden, Transparent bool
	FillParent          bool
}

// Handles and the registry are read and changed on the AppKit main thread.
type nativeWebview struct {
	owner  *Surfaces
	id     uint64
	handle unsafe.Pointer
}

var nativeViews = map[uint64]*nativeWebview{}
var nativeSerial uint64

// 창의 이벤트는 그 창의 문서에만 전달한다.
func (s *Surfaces) emit(name string, data ...any) {
	s.window.EmitEvent(name, data...)
	var value any
	if len(data) == 1 {
		value = data[0]
	} else if len(data) > 1 {
		value = data
	}
	payload, err := json.Marshal(map[string]any{"event": name, "data": value})
	if err != nil {
		log.Printf("native event: %v", err)
		return
	}
	application.InvokeSync(func() {
		for _, view := range nativeViews {
			if view.owner == s {
				view.execJS("window.__soksakNative?.receive(" + string(payload) + ")")
			}
		}
	})
}

func (s *Surfaces) close() {
	application.InvokeSync(func() {
		cancelSurfaceLayout(s.window.NativeWindow())
		unwatchMouse(s.monitor)
		for _, view := range nativeViews {
			if view.owner == s {
				view.Close()
			}
		}
		for _, shape := range s.shapes {
			shape.destroy()
		}
	})
	go s.sidecars.CloseOwner(s)
}

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

// Extra documents have a narrow host interface, separate from Wails bindings.
func invokeNative(s *Surfaces, call nativeCall) (any, error) {
	var id, key, value string
	var instance uint64
	switch call.Method {
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
	case "ModalContent", "ModalReady":
		if err := nativeArgs(call, &id, &instance); err != nil {
			return nil, err
		}
		if call.Method == "ModalContent" {
			return s.ModalContent(id, instance), nil
		}
		s.ModalReady(id, instance)
		return nil, nil
	case "OverlayPick":
		if err := nativeArgs(call, &id, &instance, &key, &value); err != nil {
			return nil, err
		}
		return nil, s.OverlayPick(id, instance, key, value)
	default:
		return nil, fmt.Errorf("unknown native call: %s", call.Method)
	}
}

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
	result, err := invokeNative(owner, call)
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
