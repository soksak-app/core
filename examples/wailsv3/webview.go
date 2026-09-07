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
	id     uint64
	handle unsafe.Pointer
}

var nativeViews = map[uint64]*nativeWebview{}
var nativeSerial uint64
var nativeService *Surfaces

func connectNativePages(app *application.App, service *Surfaces) {
	nativeService = service
	for _, name := range []string{"theme", "shell-output", "modal-content", "modal-position"} {
		app.Event.On(name, func(event *application.CustomEvent) {
			payload, err := json.Marshal(map[string]any{"event": event.Name, "data": event.Data})
			if err != nil {
				log.Printf("native event: %v", err)
				return
			}
			application.InvokeSync(func() {
				for _, view := range nativeViews {
					view.execJS("window.__soksakNative?.receive(" + string(payload) + ")")
				}
			})
		})
	}
}

func dropNativeWebviews() {
	application.InvokeSync(func() {
		cancelSurfaceLayout()
		for _, view := range nativeViews {
			view.Close()
		}
	})
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
func invokeNative(call nativeCall) (any, error) {
	s := nativeService
	var id, key, value string
	var instance uint64
	switch call.Method {
	case "Theme":
		if err := nativeArgs(call); err != nil {
			return nil, err
		}
		return s.Theme(), nil
	case "ShellOpen":
		if err := nativeArgs(call, &id); err != nil {
			return nil, err
		}
		return nil, s.ShellOpen(id)
	case "ShellWrite":
		if err := nativeArgs(call, &id, &value); err != nil {
			return nil, err
		}
		return nil, s.ShellWrite(id, value)
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
	var exists bool
	application.InvokeSync(func() { exists = nativeViews[viewID] != nil })
	if !exists {
		return
	}
	result, err := invokeNative(call)
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
