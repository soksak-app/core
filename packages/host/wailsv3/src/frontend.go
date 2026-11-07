package adapter

import (
	"math"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// Frontend is a Wails window as the Frontend port of the language host library. Two values of one window are equal.
type Frontend struct {
	window *application.WebviewWindow
}

func (f Frontend) ID() uint              { return f.window.ID() }
func (f Frontend) Name() string          { return f.window.Name() }
func (f Frontend) SetTitle(title string) { f.window.SetTitle(title) }
func (f Frontend) Show()                 { f.window.Show() }
func (f Frontend) Focus()                { f.window.Focus() }
func (f Frontend) IsFocused() bool       { return f.window.IsFocused() }
func (f Frontend) Close()                { f.window.Close() }
func (f Frontend) Maximize()             { f.window.Maximise() }
func (f Frontend) Unmaximize()           { f.window.UnMaximise() }
func (f Frontend) IsMaximized() bool     { return f.window.IsMaximised() }
func (f Frontend) IsFullscreen() bool    { return f.window.IsFullscreen() }
func (f Frontend) IsMinimized() bool     { return f.window.IsMinimised() }

// NativeWindow is the native window, or the zero Window once the framework closed the window. Wails gives the handle as a pointer
// on macOS and as an integer on Windows, and either converts to the integer of the handle.
func (f Frontend) NativeWindow() platform.Window {
	return platform.Window(uintptr(f.window.NativeWindow()))
}

// WailsPixels is the nearest integer of a logical length of the port, which Wails holds as an integer.
func WailsPixels(length float64) int { return int(math.Round(length)) }

// SetSize sets the size in logical pixels.
func (f Frontend) SetSize(width, height float64) {
	f.window.SetSize(WailsPixels(width), WailsPixels(height))
}

// SetPosition sets the position in logical pixels.
func (f Frontend) SetPosition(x, y float64) { f.window.SetPosition(WailsPixels(x), WailsPixels(y)) }

// Size is the size in logical pixels.
func (f Frontend) Size() (width, height float64) {
	w, h := f.window.Size()
	return float64(w), float64(h)
}

// Position is the position in logical pixels.
func (f Frontend) Position() (x, y float64) {
	left, top := f.window.Position()
	return float64(left), float64(top)
}

// Emit delivers an event to the page of the window.
func (f Frontend) Emit(name string, data ...any) { f.window.EmitEvent(name, data...) }

// WailsWindowEvent is the Wails event of a window event of the port.
func WailsWindowEvent(event host.WindowEvent) events.WindowEventType {
	return map[host.WindowEvent]events.WindowEventType{
		host.WindowResize:             events.Common.WindowDidResize,
		host.WindowMove:               events.Common.WindowDidMove,
		host.WindowFocus:              events.Common.WindowFocus,
		host.WindowFocusLost:          events.Common.WindowLostFocus,
		host.WindowShow:               events.Common.WindowShow,
		host.WindowHide:               events.Common.WindowHide,
		host.WindowScaleChanged:       events.Mac.WindowDidChangeBackingProperties,
		host.WindowWorkbenchEnded:     events.Mac.WebViewWebContentProcessDidTerminate,
		host.WindowWorkbenchCommitted: events.Mac.WebViewDidCommitNavigation,
	}[event]
}

// OnWindowEvent runs listener for each occurrence of event.
func (f Frontend) OnWindowEvent(event host.WindowEvent, listener func()) {
	f.window.OnWindowEvent(WailsWindowEvent(event), func(*application.WindowEvent) { listener() })
}

// OnClosing runs hook when the window is asked to close. A hook that returns true cancels the close.
func (f Frontend) OnClosing(hook func() (keep bool)) {
	f.window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if hook() {
			event.Cancel()
		}
	})
}

// AfterPresentation is the presentation notice of the main page.
func (f Frontend) AfterPresentation(done func(err error)) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	return system.AfterPresentation(f.NativeWindow(), func() { done(nil) })
}

// SettledPresentation is the settled presentation of the main page: the block of its main web view.
func (f Frontend) SettledPresentation() (unsafe.Pointer, error) {
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	return system.MainPresentation(f.NativeWindow())
}

// StartWorkbench reloads the main page.
func (f Frontend) StartWorkbench() { f.window.Reload() }

// CallWorkbench runs script in the main page.
func (f Frontend) CallWorkbench(script string) { f.window.ExecJS(script) }

// Frames is nil: WebKit draws the workbench of this host.
func (f Frontend) Frames() *host.WindowFrames { return nil }
