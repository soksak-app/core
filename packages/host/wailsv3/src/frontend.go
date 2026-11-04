package adapter

import (
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

func (f Frontend) ID() uint                     { return f.window.ID() }
func (f Frontend) Name() string                 { return f.window.Name() }
func (f Frontend) NativeWindow() unsafe.Pointer { return f.window.NativeWindow() }
func (f Frontend) SetTitle(title string)        { f.window.SetTitle(title) }
func (f Frontend) Show()                        { f.window.Show() }
func (f Frontend) Focus()                       { f.window.Focus() }
func (f Frontend) IsFocused() bool              { return f.window.IsFocused() }
func (f Frontend) Close()                       { f.window.Close() }
func (f Frontend) SetSize(width, height int)    { f.window.SetSize(width, height) }
func (f Frontend) SetPosition(x, y int)         { f.window.SetPosition(x, y) }
func (f Frontend) Size() (width, height int)    { return f.window.Size() }
func (f Frontend) Position() (x, y int)         { return f.window.Position() }
func (f Frontend) Maximise()                    { f.window.Maximise() }
func (f Frontend) UnMaximise()                  { f.window.UnMaximise() }
func (f Frontend) IsMaximised() bool            { return f.window.IsMaximised() }
func (f Frontend) IsFullscreen() bool           { return f.window.IsFullscreen() }
func (f Frontend) IsMinimised() bool            { return f.window.IsMinimised() }

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
func (f Frontend) AfterPresentation(done func()) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	return system.AfterPresentation(f.window.NativeWindow(), done)
}

// AfterSettled is the settled presentation of the main page.
func (f Frontend) AfterSettled(done func(displayed float64, err error)) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	return system.AfterSettled(f.window.NativeWindow(), done)
}

// StartWorkbench reloads the main page.
func (f Frontend) StartWorkbench() { f.window.Reload() }

// CallWorkbench runs script in the main page.
func (f Frontend) CallWorkbench(script string) { f.window.ExecJS(script) }
