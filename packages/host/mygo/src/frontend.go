package adapter

import (
	"encoding/json"
	"errors"
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

	// frames counts the frames of the workbench of the window (U7).
	frames *host.WindowFrames

	mu sync.Mutex
	// ready is true once the window drew its first frame, shown once the host asked to show it, and revealed once the window went on
	// the screen with the first screen of its workbench.
	ready, shown, revealed bool
	// revealing belongs to the main thread: the next frame of the window draws the first screen of its workbench, and the window goes
	// on the screen once that frame returns.
	revealing bool
	// held, released and closed belong to the main thread: whether the adapter holds the frames of the window, what waits for its
	// release, and whether the window closed, which no release follows.
	held     bool
	released []func()
	closed   bool
	// starting belongs to the main thread: the window holds its frames from the start of its workbench until that workbench shows its
	// first screen.
	starting bool
	// building, opening, framed and transacted belong to the main thread: the view of the window runs, the frame being built opened the
	// layout transaction and its report has not come, the frame that opened the open layout transaction presented in it, and a frame
	// that a preparation asked for presented in the open layout transaction.
	building, opening, framed, transacted bool
	// placed belongs to the main thread: the surface host of each native view element and the box that the element last gave it.
	placed map[uintptr]placedSurface
	// address belongs to the main thread: the address of the window, which names the project that it shows.
	address string
}

// Frames counts the frames of the workbench of the window.
func (f *Frontend) Frames() *host.WindowFrames { return f.frames }

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
		err = f.window.NewNativeView(uintptr(native), func(views []mygo.NativePlacement) { f.placeSurfaces(system, f.elementSurface, views) })
	}
	if err != nil {
		host.LogError("window native view", err)
	}
}

// placeSurfaces sets the frame of each surface host that the frame shows, in the Core Animation transaction of the frame. The frame
// is in the content coordinates of the window as on the other hosts, and native/darwin converts it into the container of the surface
// hosts, so the elements alone place the hosts (docs/spec/hosts.md#native-views). A surface that the frame no longer shows hides here,
// before the framework takes the keyboard from the views that left: native/darwin notes what held the keyboard when a surface hides,
// and gives it back when the surface shows. surface gives the surface host of the element that a view names.
func (f *Frontend) placeSurfaces(system platform.Platform, surface func(view uintptr) (unsafe.Pointer, bool), views []mygo.NativePlacement) {
	f.frames.SetNativeViews(int64(len(views)))
	placed := make(map[uintptr]placedSurface, len(views))
	for _, view := range views {
		last, shown := f.placed[view.View]
		handle := last.surface
		if !shown {
			// The framework names the view by the integer that the workbench gave it, so the surface host is the one of the element.
			// An element that left the window before its first placement shows nothing.
			var ok bool
			if handle, ok = surface(view.View); !ok {
				continue
			}
		}
		placed[view.View] = placedSurface{surface: handle, box: view.Box}
		if !shown || last.box != view.Box {
			system.SetSurfaceBounds(handle, view.Box.X, view.Box.Y, view.Box.W, view.Box.H)
		}
		if !shown {
			system.SetSurfaceHiddenHandle(handle, false)
		}
	}
	for view, last := range f.placed {
		if _, shown := placed[view]; !shown {
			system.SetSurfaceHiddenHandle(last.surface, true)
		}
	}
	f.placed = placed
}

// placedSurface is a surface host that a native view element placed and the box that the element last gave it.
type placedSurface struct {
	surface unsafe.Pointer
	box     mygo.RectF
}

// OpenLayout opens the surface layout transaction of the window for the frame being built, before the frame sets the frames of the
// surface hosts, and returns its ticket; it returns 0 while a layout transaction holds the frames, whose frame of the transaction
// draws inside it (docs/spec/hosts.md#native-views). Call it on the main thread.
func (f *Frontend) OpenLayout() (uint64, error) {
	if f.framework.transaction {
		return 0, nil
	}
	h := f.framework.host.Load()
	if h == nil {
		return 0, errors.New("the window has no host")
	}
	return host.OpenLayout(h, f)
}

// elementSurface returns the surface host of the element of the window whose surface host is view.
func (f *Frontend) elementSurface(view uintptr) (unsafe.Pointer, bool) {
	h := f.framework.host.Load()
	if h == nil {
		return nil, false
	}
	return host.ElementSurface(h, f, view)
}

// started builds the workbench of the window and connects the window to it. Call it on the main thread.
func (f *Frontend) started() {
	view := f.framework.workbench.Build(f)
	f.view.Store(&view)
	// The window was created hidden, and its workbench starts after its first frame, because a command reads the elements of the last
	// frame. The window goes on the screen with the first screen of its workbench (FirstScreen), as the other hosts reveal a window
	// once the first load of its main page ended (docs/spec/native-host.md#page-start).
	f.window.OnReadyToShow(func() {
		f.mu.Lock()
		first := !f.ready
		f.ready = true
		shown := f.shown
		f.mu.Unlock()
		if shown && first {
			routine.Go("workbench-start", f.startHeld)
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
		f.windowClosed()
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

// Scale is the backing scale of the window, from its native facts. A window that closed gives the error of a closed window.
func (f *Frontend) Scale() (float64, error) {
	system, err := platform.Current()
	if err != nil {
		return 0, err
	}
	return WindowScale(mygo.RunOnMain, f.name, f.NativeWindow, system.WindowFacts)
}

// WindowScale reads the backing scale of the window of name from its native facts in one step of the main thread. A step that finds
// no native window calls no native code, because native code records a read without a window as an error.
func WindowScale(invoke func(func()), name string, native func() platform.Window, read func(platform.Window) (string, error)) (float64, error) {
	var text string
	err := host.UseNativeWindow(invoke, name, native, func(window platform.Window) error {
		var err error
		text, err = read(window)
		return err
	})
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

// NativeWindow is the NSWindow, or the zero Window once the window closed.
func (f *Frontend) NativeWindow() platform.Window { return platform.Window(f.window.NativeHandle()) }

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

// Show puts the window on the screen once its workbench showed its first screen (FirstScreen). The host shows a window after it holds
// the window, so the workbench starts its host calls here.
func (f *Frontend) Show() {
	f.mu.Lock()
	first := !f.shown
	f.shown = true
	ready, revealed := f.ready, f.revealed
	f.mu.Unlock()
	if revealed {
		f.window.Show()
	}
	// A window answers commands once its workbench started, and they read the elements of its last frame, so a window that drew
	// no frame starts its workbench with its first frame.
	if ready && first {
		routine.Go("workbench-start", f.startHeld)
	}
}

// drawn follows a frame that the view of the window built: the frame of the first screen puts the window on the screen once it
// returned, as a window that is ready to show does. Call it on the main thread.
func (f *Frontend) drawn() {
	if !f.revealing {
		return
	}
	f.revealing = false
	mygo.App.WhenReady(func() {
		f.mu.Lock()
		f.revealed = true
		f.mu.Unlock()
		f.window.Show()
	})
}

// WindowEventSource adds listener to the mygo event of a window event of the port and reports whether the framework has that
// event. The workbench of a mygo window is no process and no navigation, so the two workbench events have no source.
func WindowEventSource(window *mygo.Window, event host.WindowEvent, listener func()) bool {
	sources := map[host.WindowEvent]func(func()) func(){
		host.WindowResize:    window.OnResize,
		host.WindowMove:      window.OnMove,
		host.WindowFocus:     window.OnFocus,
		host.WindowFocusLost: window.OnBlur,
		// The port names a change of the occlusion of the window (windows.go), which also comes when the window opens and closes.
		host.WindowShow: func(listener func()) func() {
			return window.OnOcclusionChange(func(occluded bool) {
				if !occluded {
					listener()
				}
			})
		},
		host.WindowHide: func(listener func()) func() {
			return window.OnOcclusionChange(func(occluded bool) {
				if occluded {
					listener()
				}
			})
		},
		host.WindowScaleChanged: func(listener func()) func() {
			return window.OnScaleChange(func(float64) { listener() })
		},
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
// transaction the preparation held the frames of the window from its start, so the frame that this call asks for is the one frame of
// the window in the transaction: the call releases the window and holds it again from inside that notice, so that no later frame
// presents before the transaction ends. A preparation that took over the transaction that a frame of the window opened has that frame
// for its frame once it presented in the transaction: the frame drew the lines that the preparation placed, and done runs at once
// without asking for another, which could only present after the commit that waits for this notice, and the preparation places the
// surfaces that it creates itself. A preparation that took over a transaction whose frame a preparation already asked for has no
// frame: that frame holds its drawable until the commit, so another frame would wait for the commit that waits for this notice, and
// done fails at once. A diagnostics recording holds the time of this call as the request of the frame of the transaction and the time
// of the notice as its presentation.
func (f *Frontend) AfterPresentation(done func(err error)) error {
	recorded := func() {}
	if f.framework.transaction {
		system, err := platform.Current()
		if err != nil {
			return err
		}
		if capturer, ok := system.(platform.Capturer); ok {
			recorded = capturer.LayoutTraceRequested()
		}
		if f.framed {
			recorded()
			done(nil)
			return nil
		}
		if f.transacted {
			done(errTransactionPresented)
			return nil
		}
		f.release()
	}
	return f.presented(false, func(err error) {
		if err == nil && f.framework.transaction {
			recorded()
			f.transacted = true
			f.hold()
		}
		done(err)
	})
}

// errTransactionPresented is the failure of the notice of a preparation that took over a transaction whose frame already presented.
var errTransactionPresented = errors.New("the frame of the transaction already presented; another frame would wait for the commit")

// opensLayout reports whether the layout transaction that owner starts opens in the frame being built of the window: the view of the
// window runs, which opens the layout of its frame (OpenLayout), and nothing holds the frames of the window.
func (f *Frontend) opensLayout(owner platform.Window) bool {
	return f.building && !f.held && f.NativeWindow() == owner
}

// openedInFrame has the frame being built, which opened the layout transaction, be the frame of the transaction: the frame presents in
// it, and the report of the frame holds the frames of the window (frameEnded). The frame asks for no notice, which would ask for
// another frame: the window would draw it after the commit with nothing changed, and the report of the opening frame would tell that
// the window asks for a frame, so the window would not be settled.
func (f *Frontend) openedInFrame() {
	f.opening = true
}

// frameEnded reads the report of each frame of the window (FrameRecorder), on the main thread that drew it. The report of the frame
// that opened the layout transaction tells whether it presented in the transaction: then it is the frame of the transaction, the
// window holds its frames until the transaction ends, and the preparation that takes the transaction over hears that frame
// (AfterPresentation). A frame that waits for a drawable or found none leaves the preparation to ask for its own, and a frame built
// for a capture leaves the transaction to the next frame of the surface. A report after the end of the transaction changes nothing.
func (f *Frontend) frameEnded(outcome ui.FrameOutcome) {
	if !f.opening || outcome == ui.FrameHeld {
		return
	}
	f.opening = false
	f.framed = outcome == ui.FrameTransaction || outcome == ui.FrameImmediate || outcome == ui.FrameUndamaged
	f.hold()
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

// release lets the window draw and runs what waited for it. A window whose new workbench has not shown its first screen keeps its
// hold. Call it on the main thread.
func (f *Frontend) release() {
	if !f.held || f.starting {
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

// whenReleased runs run after the release of the window, or at once when the window is not held or closed. Call it on the main
// thread.
func (f *Frontend) whenReleased(run func()) {
	if !f.held || f.closed {
		run()
		return
	}
	f.released = append(f.released, run)
}

// windowClosed runs what waits for the release of a window that closed: the window left the open windows, so the end of a layout
// transaction does not release it, and each wait asks again and hears that the window closed. Call it on the main thread.
func (f *Frontend) windowClosed() {
	f.closed = true
	waiting := f.released
	f.released = nil
	for _, run := range waiting {
		run()
	}
}

// Address returns the address of the window: the URL that the host opened it with, or the last that the workbench set.
func (f *Frontend) Address() string { return f.address }

// SetAddress sets the address of the window, which the next start of the workbench reads.
func (f *Frontend) SetAddress(address string) { f.address = address }

// StartWorkbench ends the workbench of the window and builds it again. A workbench of a window that the host holds starts at once.
// A shown window keeps its last frame until the new workbench shows its first screen (FirstScreen), as WebKit keeps the previous
// page of a reload on the screen until the new page renders (docs/spec/native-host.md#page-start).
func (f *Frontend) StartWorkbench() {
	var shown bool
	mygo.RunOnMain(func() {
		f.mu.Lock()
		shown = f.shown
		f.mu.Unlock()
		if shown {
			f.hold()
			f.starting = true
		}
		f.framework.workbench.Close(f)
		view := f.framework.workbench.Build(f)
		f.view.Store(&view)
	})
	f.window.Invalidate()
	if shown {
		routine.Go("workbench-start", f.startHeld)
	}
}

// FirstScreen tells the window that its workbench shows its first screen. A window that did not go on the screen yet goes on it with
// the frame of that screen, and a restarted workbench lets its window draw again, unless a layout transaction holds the window,
// whose end releases it. Call it on the main thread.
func (f *Frontend) FirstScreen() {
	if f.starting {
		f.starting = false
		if !f.framework.transaction {
			f.release()
		}
	}
	f.mu.Lock()
	revealed := f.revealed
	f.mu.Unlock()
	if !revealed && !f.revealing {
		f.revealing = true
		f.window.Invalidate()
	}
}

// startHeld gives the workbench that the window built its new start, and then tells it that the host answers its calls. A start
// that the host refused ends as the failure of that start, as a main page whose start document failed: the workbench is not told
// that it started (docs/spec/native-host.md#page-start). A start whose window closed meanwhile, as a quit closes the last window,
// names no window and ends without a failure, since no screen shows it and no workbench takes it. Call it outside the main thread,
// because the start waits for steps of the main thread.
func (f *Frontend) startHeld() {
	if h := f.framework.host.Load(); h != nil {
		if err := f.framework.start(h, f); errors.Is(err, host.ErrNoStartWindow) {
			return
		} else if err != nil {
			host.LogError("workbench start", err)
			f.framework.workbench.StartFailed(f, err)
			return
		}
	}
	f.framework.workbench.Shown(f)
}

// CallWorkbench delivers script to the workbench of the window.
func (f *Frontend) CallWorkbench(script string) { f.framework.workbench.Call(f, script) }
