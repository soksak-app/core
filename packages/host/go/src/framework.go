// The framework port: the two interfaces through which the language host library reaches the application framework
// (docs/spec/hosts.md#mygo-host). A framework adapter implements both and holds Run.

package host

import (
	"context"
	"unsafe"
)

// Framework is the application of a framework: everything that the library asks of the framework without naming a window
// of the page.
type Framework interface {
	// ApplicationName is wailsv3, mygo or tauriv2: the application of endpoint.json, the name of the endpoint socket, the host
	// of the release key of the application update and the host of the state file of the debug view.
	ApplicationName() string
	// DisplayName is the end of a window title, as "Wails v3".
	DisplayName() string
	// MainPage reports whether a window shows the workbench in a main page. A framework that draws the workbench in native UI has
	// no main web view, and the library calls no operation of a main web view on its windows.
	MainPage() bool
	// RecordSteps has the main thread record its steps until stop returns, when the framework hands the callbacks of the
	// main thread to a worker; otherwise it returns nil. report and lost run on a goroutine of the framework.
	RecordSteps(report func(StepRecord), lost func(uint64)) (stop func())
	// RegisteredCallbacks is how many callbacks the framework registered with the native side and never frees, 0 for a
	// framework without such a limit.
	RegisteredCallbacks() int64
	// Step runs task as one step of the main thread and returns when it returned.
	Step(task func())
	// Post runs task as a later step of the main thread and returns at once.
	Post(task func())
	// Quit ends the application through the quit of the framework.
	Quit()
	// ChooseFolder shows the folder panel attached to window and returns the chosen path, or "" when the person cancelled.
	ChooseFolder(window Frontend, title string) (string, error)
	// SaveFile shows the save panel attached to window, in directory when it is not "", and returns the chosen path, or "" when
	// the person cancelled.
	SaveFile(window Frontend, name, directory string) (string, error)
	// SetMenu installs the application menu.
	SetMenu(menus []Menu) error
	// InstallDock installs the Dock menu, whose new window item runs newWindow. Call it on the main thread.
	InstallDock(newWindow func()) error
	// NewWindow creates a window with its title bar. Windows returns the windows that are open.
	NewWindow(options WindowOptions) Frontend
	Windows() []Frontend
}

// WindowOptions are the values of a window that the library creates. A window starts hidden, and the host shows it when the
// first screen is displayed (docs/spec/native-host.md#page-start).
type WindowOptions struct {
	Name, Title, URL string
	// Width and Height are logical pixels.
	Width, Height float64
}

// WindowEvent is a change of a window that a Frontend reports.
type WindowEvent int

const (
	WindowResize WindowEvent = iota
	WindowMove
	WindowFocus
	WindowFocusLost
	WindowShow
	WindowHide
	// WindowScaleChanged reports that the backing scale of the window changed.
	WindowScaleChanged
	// WindowWorkbenchEnded reports that the process that draws the workbench ended, and WindowWorkbenchCommitted that the
	// workbench committed a navigation. A frontend that has no such process does not report them.
	WindowWorkbenchEnded
	WindowWorkbenchCommitted
)

// Frontend is one window of a framework and the workbench that it shows.
type Frontend interface {
	// ID identifies the window in this run and Name is its window identifier of the endpoint.
	ID() uint
	Name() string
	// NativeWindow is the native window handle, or nil once the framework closed the window.
	NativeWindow() unsafe.Pointer
	// Emit delivers an event to the workbench of the window.
	Emit(name string, data ...any)
	SetTitle(title string)
	// Show puts the window on the screen. Call it outside the main thread.
	Show()
	Focus()
	// IsFocused reports whether the window is the key window of the application.
	IsFocused() bool
	Close()
	// SetSize, SetPosition, Size and Position take and give logical pixels.
	SetSize(width, height float64)
	SetPosition(x, y float64)
	Size() (width, height float64)
	Position() (x, y float64)
	Maximize()
	Unmaximize()
	IsMaximized() bool
	IsFullscreen() bool
	IsMinimized() bool
	// OnWindowEvent runs listener for each occurrence of event.
	OnWindowEvent(event WindowEvent, listener func())
	// OnClosing runs hook when the window is asked to close. A hook that returns true keeps the window open.
	OnClosing(hook func() (keep bool))
	// AfterPresentation is the presentation notice: done runs after the workbench presented the state of this step, with the
	// failure when it cannot present that state. Call it on the main thread.
	AfterPresentation(done func(err error)) error
	// SettledPresentation is the settled presentation: it makes the block that brings the content of the window to the screen in
	// its current state, which the caller passes to the settled wait of the platform. Call it on the main thread.
	SettledPresentation() (unsafe.Pointer, error)
	// StartWorkbench starts the workbench of the window again.
	StartWorkbench()
	// CallWorkbench is the workbench call channel: it runs script in the workbench.
	CallWorkbench(script string)
	// Frames counts the frames of the workbench of the window, or is nil on a host that does not draw them.
	Frames() *WindowFrames
}

// framework is the framework that Prepare received.
var framework Framework

// mainThreadStep runs task as one step of the main thread and returns when it returned.
func mainThreadStep(task func()) { framework.Step(task) }

// mainThreadPost runs task as a later step of the main thread.
func mainThreadPost(task func()) { framework.Post(task) }

// mainThreadResult runs task as one step of the main thread and returns its result.
func mainThreadResult[T any](task func() (T, error)) (result T, err error) {
	mainThreadStep(func() { result, err = task() })
	return result, err
}

type frontendKey struct{}

// WithFrontend returns ctx with the window of a host call.
func WithFrontend(ctx context.Context, window Frontend) context.Context {
	return context.WithValue(ctx, frontendKey{}, window)
}

// frontendOf returns the window of a host call.
func frontendOf(ctx context.Context) (Frontend, bool) {
	window, ok := ctx.Value(frontendKey{}).(Frontend)
	return window, ok
}
