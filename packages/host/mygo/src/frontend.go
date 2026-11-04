package adapter

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// Frontend is a mygo window as the Frontend port of the language host library, with the workbench that it draws.
type Frontend struct {
	name      string
	framework *Framework
	window    *mygo.Window
	// content is what the window shows, which holds its element tree.
	content *ui.Content
	// view is the view of the current workbench of the window.
	view atomic.Pointer[func(c *ui.Context)]

	mu sync.Mutex
	// ready is true once the window drew its first frame, and shown once the host asked to show it.
	ready, shown bool
	// held and released belong to the main thread: whether the adapter holds the frames of the window, and what waits for its release.
	held     bool
	released []func()
	// placed belongs to the main thread: the box that each native view element last gave its surface host.
	placed map[uintptr]mygo.RectF
	// address belongs to the main thread: the address of the window, which names the project that it shows.
	address string
}

// Window is the mygo window.
func (f *Frontend) Window() *mygo.Window { return f.window }

// ElementTree reads the element tree of the last frame of the window. Call it on the main thread.
func (f *Frontend) ElementTree() ([]ui.ElementNode, error) { return f.content.ElementTree() }

// ActElement performs an action on an element of the last frame of the window. Call it on the main thread.
func (f *Frontend) ActElement(id uint64, action ui.Actions, text string) error {
	return f.content.ActElement(id, action, text)
}

// placeNativeView puts the native view of the window under its content. Every surface of the window lies in that view, so a window
// without it can show no surface, and each surface reports that failure. Call it on the main thread.
func (f *Frontend) placeNativeView() {
	system, err := platform.Current()
	if err == nil {
		native := system.NativeView(f.NativeWindow())
		err = f.window.NewNativeView(uintptr(native), func(views []mygo.NativePlacement) { f.placeSurfaces(system, views) })
	}
	if err != nil {
		host.LogError("window native view", err)
	}
}

// placeSurfaces sets the frame of each surface host that the frame shows, in the Core Animation transaction of the frame. The frame
// is in the content coordinates of the window as on the other hosts, and native/darwin converts it into the container of the surface
// hosts, so the elements alone place the hosts (docs/spec/hosts.md#native-views). A surface that the frame no longer shows hides here,
// before the framework takes the keyboard from the views that left: native/darwin notes what held the keyboard when a surface hides,
// and gives it back when the surface shows.
func (f *Frontend) placeSurfaces(system platform.Platform, views []mygo.NativePlacement) {
	placed := make(map[uintptr]mygo.RectF, len(views))
	for _, view := range views {
		placed[view.View] = view.Box
		surface := *(*unsafe.Pointer)(unsafe.Pointer(&view.View))
		box, shown := f.placed[view.View]
		if !shown || box != view.Box {
			system.SetSurfaceBounds(surface, view.Box.X, view.Box.Y, view.Box.W, view.Box.H)
		}
		if !shown {
			system.SetSurfaceHiddenHandle(surface, false)
		}
	}
	for view := range f.placed {
		if _, shown := placed[view]; !shown {
			system.SetSurfaceHiddenHandle(*(*unsafe.Pointer)(unsafe.Pointer(&view)), true)
		}
	}
	f.placed = placed
}

// started builds the workbench of the window and connects the window to it. Call it on the main thread.
func (f *Frontend) started() {
	view := f.framework.workbench.Build(f)
	f.view.Store(&view)
	// The window was created hidden and shows when its first frame is drawn, as the main page of the other hosts reveals its window
	// after the first load (docs/spec/hosts.md#operation-groups).
	f.window.OnReadyToShow(func() {
		f.mu.Lock()
		f.ready = true
		shown := f.shown
		f.mu.Unlock()
		if shown {
			f.window.Show()
		}
	})
	// A listener makes the window take the files that no element of the workbench takes (docs/spec/native-surfaces.md).
	f.window.OnFileDrop(func(event *mygo.FileDropEvent) {
		text, err := FileDropText(event)
		if err != nil {
			host.LogError("file drop", err)
			return
		}
		f.Emit("files-dropped", text)
	})
	f.window.OnClosed(func() {
		f.framework.workbench.Close(f)
		f.framework.closed(f)
	})
}

func (f *Frontend) ID() uint              { return uint(f.window.ID()) }
func (f *Frontend) Name() string          { return f.name }
func (f *Frontend) SetTitle(title string) { f.window.SetTitle(title) }
func (f *Frontend) Focus()                { f.window.Focus() }
func (f *Frontend) IsFocused() bool       { return f.window.IsFocused() }
func (f *Frontend) Close()                { f.window.Close() }
func (f *Frontend) Maximize()             { f.window.Maximize() }
func (f *Frontend) Unmaximize()           { f.window.Unmaximize() }
func (f *Frontend) IsMaximized() bool     { return f.window.IsMaximized() }
func (f *Frontend) IsFullscreen() bool    { return f.window.IsFullScreen() }
func (f *Frontend) IsMinimized() bool     { return f.window.IsMinimized() }

// FileDropText is the text of the event files-dropped: the JSON of {urls, x, y} that the file drop view writes on the hosts with a
// main page (docs/spec/native-surfaces.md), the workbench parses it. The URL of a folder ends with a slash, as that view writes it, and
// a path that no longer resolves refuses the drop as that view refuses it.
func FileDropText(event *mygo.FileDropEvent) (string, error) {
	urls := make([]string, 0, len(event.Paths))
	for _, path := range event.Paths {
		info, err := os.Stat(path)
		if err != nil {
			return "", fmt.Errorf("the drop was refused: %w", err)
		}
		if info.IsDir() {
			path = strings.TrimSuffix(path, "/") + "/"
		}
		address := url.URL{Scheme: "file", Path: path}
		urls = append(urls, address.String())
	}
	text, err := json.Marshal(struct {
		URLs []string `json:"urls"`
		X    int      `json:"x"`
		Y    int      `json:"y"`
	}{urls, event.X, event.Y})
	if err != nil {
		return "", fmt.Errorf("the drop was refused: %w", err)
	}
	return string(text), nil
}

// Pixels is the nearest integer of a logical length of the port, which the framework holds as an integer.
func Pixels(length float64) int { return int(math.Round(length)) }

// SetSize sets the size in logical pixels.
func (f *Frontend) SetSize(width, height float64) { f.window.SetSize(Pixels(width), Pixels(height)) }

// SetPosition sets the position in logical pixels.
func (f *Frontend) SetPosition(x, y float64) { f.window.SetPosition(Pixels(x), Pixels(y)) }

// Size is the size in logical pixels.
func (f *Frontend) Size() (width, height float64) {
	w, h := f.window.Size()
	return float64(w), float64(h)
}

// ContentSize is the content size in logical pixels.
func (f *Frontend) ContentSize() (width, height float64) {
	w, h := f.window.ContentSize()
	return float64(w), float64(h)
}

// Visible tells whether the window shows, which it does not while it is minimized or not shown.
func (f *Frontend) Visible() bool { return f.window.IsVisible() && !f.window.IsMinimized() }

// Scale is the backing scale of the window, from its native facts.
func (f *Frontend) Scale() (float64, error) {
	system, err := platform.Current()
	if err != nil {
		return 0, err
	}
	var text string
	mygo.RunOnMain(func() { text, err = system.WindowFacts(f.NativeWindow()) })
	if err != nil {
		return 0, err
	}
	var facts struct {
		Scale float64 `json:"scale"`
	}
	if err := json.Unmarshal([]byte(text), &facts); err != nil {
		return 0, fmt.Errorf("window facts: %w", err)
	}
	return facts.Scale, nil
}

// Position is the position in logical pixels.
func (f *Frontend) Position() (x, y float64) {
	left, top := f.window.Position()
	return float64(left), float64(top)
}

// NativeWindow is the NSWindow, or nil once the window closed. The framework gives the handle as an integer.
func (f *Frontend) NativeWindow() unsafe.Pointer {
	handle := f.window.NativeHandle()
	return *(*unsafe.Pointer)(unsafe.Pointer(&handle))
}

// Emit delivers an event to the workbench of the window. The reload request of a main page starts the workbench again, because a
// workbench without a page has nothing to read again.
func (f *Frontend) Emit(name string, data ...any) {
	if name == "page-reload" {
		routine.Go("workbench-reload", f.StartWorkbench)
		return
	}
	f.framework.workbench.Emit(f, name, data...)
}

// Invalidate asks for a frame of the workbench of the window.
func (f *Frontend) Invalidate() { f.window.Invalidate() }

// SetBackdrop sets the color of the window behind its content. Every surface lies under the content, in a hole of it, so a page without
// a background of its own shows this color.
func (f *Frontend) SetBackdrop(color string) error { return f.window.SetBackgroundColor(color) }

// Show puts the window on the screen, once the window drew its first frame. The host shows a window after it holds the window, so
// the workbench starts its host calls here.
func (f *Frontend) Show() {
	f.mu.Lock()
	first := !f.shown
	f.shown = true
	ready := f.ready
	f.mu.Unlock()
	if first {
		routine.Go("workbench-start", f.startHeld)
	}
	if ready {
		f.window.Show()
	}
}

// WindowEventSource adds listener to the mygo event of a window event of the port and reports whether the framework has that
// event. The workbench of a mygo window is no process and no navigation, so the two workbench events have no source.
func WindowEventSource(window *mygo.Window, event host.WindowEvent, listener func()) bool {
	sources := map[host.WindowEvent]func(func()) func(){
		host.WindowResize:    window.OnResize,
		host.WindowMove:      window.OnMove,
		host.WindowFocus:     window.OnFocus,
		host.WindowFocusLost: window.OnBlur,
		host.WindowShow:      window.OnShow,
		host.WindowHide:      window.OnHide,
	}
	source, ok := sources[event]
	if ok {
		source(listener)
	}
	return ok
}

// OnWindowEvent runs listener for each occurrence of event. mygo fires the event on the main thread, and a listener of the host
// waits for steps of the main thread and for its locks, so it runs on a goroutine of its own.
func (f *Frontend) OnWindowEvent(event host.WindowEvent, listener func()) {
	WindowEventSource(f.window, event, func() { routine.Go("window-event", listener) })
}

// OnClosing runs hook when the window is asked to close. A hook that returns true cancels the close.
func (f *Frontend) OnClosing(hook func() (keep bool)) {
	f.window.OnClose(func(event *mygo.CloseEvent) {
		if hook() {
			event.PreventDefault()
		}
	})
}

// presented asks for a frame of the window and calls done when it presented. A frame that found no drawable is asked for again. A
// frame that the window holds fails, or, when waits is true, is asked for again after the release of the window.
func (f *Frontend) presented(waits bool, done func(err error)) error {
	var whenHeld func(again func())
	if waits {
		whenHeld = f.whenReleased
	}
	return AwaitPresentation(f.name, f.window.AfterPresent, whenHeld, done)
}

// AwaitPresentation asks notice for the notice of a frame of the named window and calls done once a frame presented. A frame that
// found no drawable asks again, and a held frame asks again through whenHeld; with no whenHeld, a held frame is the error of done, as
// is every frame that will not present.
func AwaitPresentation(name string, notice func(func(mygo.Presentation, error)) error, whenHeld func(again func()), done func(err error)) error {
	return notice(func(presentation mygo.Presentation, failure error) {
		again := func() {
			if err := AwaitPresentation(name, notice, whenHeld, done); err != nil {
				done(err)
			}
		}
		switch {
		case presentation == mygo.Presented, presentation == mygo.PresentNoDamage:
			done(nil)
		case presentation == mygo.PresentNoDrawable:
			again()
		case presentation == mygo.PresentHeld && whenHeld != nil:
			whenHeld(again)
		case presentation == mygo.PresentFailed:
			done(failure)
		default:
			done(fmt.Errorf("the frame of window %s did not present: %s", name, presentation))
		}
	})
}

// AfterPresentation is the presentation notice of the workbench: done runs after the frame of this step presented. In a layout
// transaction the window holds its frames from inside that notice, so that no later frame presents before the transaction ends.
func (f *Frontend) AfterPresentation(done func(err error)) error {
	return f.presented(false, func(err error) {
		if err == nil && f.framework.transaction {
			f.hold()
		}
		done(err)
	})
}

// SettledPresentation is the settled presentation of the workbench: the block that asks for a frame of the window. A window that the
// transaction of another window holds presents the frame that it draws once that transaction ended.
func (f *Frontend) SettledPresentation() (unsafe.Pointer, error) {
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	return system.FunctionPresentation(func(presented func(err error)) error {
		return f.presented(true, presented)
	})
}

// hold keeps the window from drawing until release. Call it on the main thread.
func (f *Frontend) hold() {
	if !f.held {
		f.held = true
		f.window.HoldFrames()
	}
}

// release lets the window draw and runs what waited for it. Call it on the main thread.
func (f *Frontend) release() {
	if !f.held {
		return
	}
	f.held = false
	f.window.ReleaseFrames()
	waiting := f.released
	f.released = nil
	for _, run := range waiting {
		run()
	}
}

// whenReleased runs run after the release of the window. Call it on the main thread.
func (f *Frontend) whenReleased(run func()) {
	if !f.held {
		run()
		return
	}
	f.released = append(f.released, run)
}

// Address returns the address of the window: the URL that the host opened it with, or the last that the workbench set.
func (f *Frontend) Address() string { return f.address }

// SetAddress sets the address of the window, which the next start of the workbench reads.
func (f *Frontend) SetAddress(address string) { f.address = address }

// StartWorkbench ends the workbench of the window and builds it again. A workbench of a window that the host holds starts at once.
func (f *Frontend) StartWorkbench() {
	mygo.RunOnMain(func() {
		f.framework.workbench.Close(f)
		view := f.framework.workbench.Build(f)
		f.view.Store(&view)
	})
	f.window.Invalidate()
	f.mu.Lock()
	shown := f.shown
	f.mu.Unlock()
	if shown {
		routine.Go("workbench-start", f.startHeld)
	}
}

// startHeld gives the workbench that the window built its new start, and then tells it that the host answers its calls. Call it
// outside the main thread, because the start waits for steps of the main thread.
func (f *Frontend) startHeld() {
	if h := f.framework.host.Load(); h != nil {
		if err := host.StartWorkbench(h, f); err != nil {
			host.LogError("workbench start", err)
		}
	}
	f.framework.workbench.Shown(f)
}

// CallWorkbench delivers script to the workbench of the window.
func (f *Frontend) CallWorkbench(script string) { f.framework.workbench.Call(f, script) }
