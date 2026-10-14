// Project windows, the window registry, ready, close and termination handling, and the window state.

package host

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// windowTitle is the title of a window that has no open project, and titleSuffix is the end of the title of a project window.
const (
	windowTitle = "soksak / Wails v3"
	titleSuffix = " / Wails v3"
)

// setTitle changes the window title and records it as the value that windows.list returns.
func (s *Surfaces) setTitle(title string) {
	s.mu.Lock()
	s.title = title
	s.mu.Unlock()
	s.window.SetTitle(title)
	if s.host != nil {
		routine.Go("windows-changed", s.host.windowsChanged)
	}
}

// The content size when a window is created.
const (
	startWidth  = 1200
	startHeight = 760
)

// Host selects the native state of the calling window. Wails binds the public methods of Host to the page.
type Host struct {
	quit Quit
	// update is the command of an application update that the shutdown starts; h.mu guards it.
	update     *exec.Cmd
	removals   Removals
	nextWindow uint64
	workspace  *Workspace
	opening    sync.Mutex
	mu         sync.Mutex
	windows    map[uint]*Surfaces
	owners     map[string]*Surfaces
	sidecars   *Sidecars
	plugins    *Plugins
	// buttons is the value of host.buttons. It installs the watch after the application started and before endpoint.json is written.
	buttons *Buttons
	// logNotices publishes the value of host.log and the host event debug-log-changed. It starts with the event log.
	logNotices *LogNotices
	configDir  string
	// debugSaving is the destination of the save of the logs folder that is being written, or ""; h.mu guards it.
	debugSaving string
	// events is the event writer of the host; Run starts it after the application log.
	events *EventLog
	// endpoint is the local endpoint and relay is the exposure requests sent to the page.
	endpoint *Endpoint
	relay    *Relay[relayTarget]
	// notifications is the permission state that the notification center announced last.
	notifications NotificationState
	// deepLinks holds the deep links that arrived before the first window was ready.
	deepLinks DeepLinkQueue
}

// errNoWindow is returned when this application has no window. Every call here lays out or reads something of that window,
// so none of them can succeed.
var errNoWindow = errors.New("the main window is gone")

// UseNativeWindow reads the native window of the window name with native in one step of the UI thread that invoke runs, and runs use with that window.
// The destroy of Wails closes the window on the UI thread and sets the native window to nil, so a window closed before that step
// is nil. For that window, it does not run use and returns the error 1003 of a window that does not exist. Native code does not receive a closed
// window.
func UseNativeWindow(invoke func(func()), name string, native func() unsafe.Pointer, use func(window unsafe.Pointer) error) error {
	var err error
	invoke(func() {
		window := native()
		if window == nil {
			err = errMissingWindow(name)
			return
		}
		err = use(window)
	})
	return err
}

// useWindow runs use with the native window of this window in one step of the UI thread. A window that closed before that step gives 1003.
func (s *Surfaces) useWindow(use func(window unsafe.Pointer) error) error {
	return UseNativeWindow(application.InvokeSync, s.name, s.window.NativeWindow, use)
}

// nativeError converts the error of an operation that used a native window to an error of code. The error 1003 of a closed window is left as it is.
func nativeError(code int, err error) error {
	var coded *RPCError
	if err == nil || errors.As(err, &coded) {
		return err
	}
	return rpcError(code, "%v", err)
}

func newHost(directory string) (*Host, error) {
	h := &Host{workspace: NewWorkspace(directory), configDir: directory, windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{},
		relay: NewRelay[relayTarget]()}
	// apply applies an operation to the sidecars: a changed sidecar is replaced and a removed one stopped, so a page that
	// reloads uses the installed executables (docs/spec/installation.md#applying-a-change).
	apply := func() error {
		ApplyPluginEventClasses(h.events, directory)
		declarations, err := InstalledSidecars(directory)
		if err != nil {
			return fmt.Errorf("installed plugins: %w", err)
		}
		return h.sidecars.Declare(declarations)
	}
	plugins, err := NewPlugins(directory, apply, h.notifyPlugins)
	if err != nil {
		return nil, err
	}
	h.plugins = plugins
	return h, nil
}

func (h *Host) surface(ctx context.Context) (*Surfaces, error) {
	win, ok := ctx.Value(application.WindowKey).(*application.WebviewWindow)
	if !ok {
		return nil, fmt.Errorf("host call has no window")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.windows[win.ID()]
	if s == nil {
		return nil, errNoWindow
	}
	return s, nil
}

type WindowGeometry struct {
	X      int32   `json:"x"`
	Y      int32   `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func (h *Host) WindowNew() {
	h.newWindow(fmt.Sprintf("project-window-%d", atomic.AddUint64(&h.nextWindow, 1)), "/")
}

// announceLogNotice tells every window the host event `debug-log-changed` and the endpoint watchers of the host status `host.log` the
// notice of a change of the event log.
func (h *Host) announceLogNotice(notice LogNotice) {
	h.mu.Lock()
	windows := make([]*Surfaces, 0, len(h.windows))
	for _, s := range h.windows {
		windows = append(windows, s)
	}
	h.mu.Unlock()
	for _, s := range windows {
		s.Emit("debug-log-changed", notice)
	}
	h.endpoint.NotifyWatchers("host.log", notice)
}

func (h *Host) notifyWorkspace() {
	h.mu.Lock()
	windows := make([]*Surfaces, 0, len(h.windows))
	for _, s := range h.windows {
		windows = append(windows, s)
	}
	h.mu.Unlock()
	for _, s := range windows {
		s.Emit("workspace-changed")
	}
}

func (h *Host) WindowState(ctx context.Context) (*WindowGeometry, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return nil, err
	}
	if s.window.IsMaximised() || s.window.IsFullscreen() || s.window.IsMinimised() {
		return nil, nil
	}
	x, y := s.window.Position()
	width, height := s.window.Size()
	return &WindowGeometry{X: int32(x), Y: int32(y), Width: float64(width), Height: float64(height)}, nil
}

func (h *Host) WindowReady(ctx context.Context) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	h.mu.Lock()
	s.ready = true
	readied := s.readied
	s.readied = nil
	h.mu.Unlock()
	s.first.Do(func() { s.Emit("page-ready") })
	s.replayRegistrations()
	routine.Go("windows-changed", h.windowsChanged)
	routine.Go("deep-link-ready", func() { h.deepLinks.Ready(h.runDeepLink) })
	for _, ready := range readied {
		close(ready)
	}
	routine.Go("window-rewatch", s.rewatch)
	return nil
}

func (h *Host) WindowClose(ctx context.Context) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	h.mu.Lock()
	s.ready = false
	h.mu.Unlock()
	s.window.Close()
	return nil
}

// WindowCloseKept records that the page kept a modified tab when the window was asked to close, which ends a quit that
// asked the window (docs/spec/hosts.md#process-lifecycle).
func (h *Host) WindowCloseKept(ctx context.Context) error {
	if _, err := h.surface(ctx); err != nil {
		return err
	}
	h.quit.Cancel()
	h.cancelUpdate()
	// A request of the operating system waits for its answer; the application does not quit, so the answer is the
	// cancellation.
	application.InvokeSync(system.CancelQuitRequests)
	return nil
}

// prepareWindow fits the sizes of the content and the main web view of the window. Call it on the UI thread.
func prepareWindow(win *application.WebviewWindow) {
	if err := system.PrepareWindow(win.NativeWindow()); err != nil {
		LogError("window prepare", err)
	}
}

// cancelLayout cancels the surface layout in progress in the window. Call it on the UI thread.
func cancelLayout(win *application.WebviewWindow) {
	owner := win.NativeWindow()
	if err := system.EnqueueUI(func() {
		if err := system.CancelLayout(owner); err != nil {
			LogError("surface layout cancel", err)
		}
	}); err != nil {
		LogError("surface layout cancel", err)
	}
}

// handleNavigation wraps the handling of the main webview navigation callback in a diagnostic build. A check delays the handling and
// confirms from the record that it finished. It is nil in other builds.
var handleNavigation func(s *Surfaces, handle func())

// An app DOM reload replaces all plugin documents but does not end the terminal sessions.
func (s *Surfaces) reloadSurfaceDocuments() {
	if err := system.CancelLayout(s.window.NativeWindow()); err != nil {
		LogError("surface layout cancel", err)
		return
	}
	ids := make([]string, 0, len(s.views))
	for id, view := range s.views {
		system.SetSurfaceHiddenHandle(view.handle, true)
		s.closeSurfaceDocuments(id)
		s.closeSurfaceImages(id)
		s.images.BeginGeneration(id)
		ids = append(ids, id)
	}
	s.mu.Lock()
	clear(s.compositionRevisions)
	s.mu.Unlock()
	s.surfacesClosed(ids)
	s.windowChanged()
}

// newWindow runs the window creation on the UI thread in a state in which the window registry lock is released.
func (h *Host) newWindow(name, url string) *Surfaces {
	win := application.Get().Window.NewWithOptions(application.WebviewWindowOptions{
		Name: name, Title: windowTitle, Width: startWidth, Height: startHeight,
		Mac: application.MacWindow{TitleBar: application.MacTitleBarHidden},
		// The window is shown after the first screen is displayed (docs/spec/native-host.md#page-start). When the preparation ends, reveal shows it.
		URL: url, DevToolsEnabled: true, BackgroundColour: application.NewRGB(16, 17, 23), Hidden: true,
	})
	s := NewSurfaces(win, h.sidecars)
	s.host, s.name, s.title = h, name, windowTitle
	h.mu.Lock()
	h.windows[win.ID()] = s
	h.mu.Unlock()
	routine.Go("windows-changed", h.windowsChanged)
	// The native view is placed over the DOM, so the page handles a dropped file based on the DOM element at that point.
	var dropOnce sync.Once
	place := func(*application.WindowEvent) {
		application.InvokeSync(func() {
			if err := system.SetMainWebview(win.NativeWindow()); err != nil {
				fatalError("main webview identity", err)
			}
			if err := system.ConfigureMainWindow(win.NativeWindow(), s.Theme().Scheme == "dark"); err != nil {
				fatalError("main window configuration", err)
			}
			prepareWindow(win)
			// The drop view enters the window composition view, and the composition view has the size of the main web view at the time it was created. It is registered after the main web view
			// is fitted to the content area.
			dropOnce.Do(func() {
				main, err := system.MainWebview(win.NativeWindow())
				if err == nil {
					// The page interprets the content and reports errors (core.drop).
					err = system.FileDrop(main, func(payload string) {
						s.Emit("files-dropped", payload)
					})
				}
				if err != nil {
					fatalError("file drop", err)
				}
			})
		})
	}
	win.OnWindowEvent(events.Common.WindowDidResize, place)
	win.OnWindowEvent(events.Common.WindowShow, place)
	// WindowShow arrives when the occlusion state of the window changes to visible. It does not arrive for a window that was opened while completely covered by the window of another application,
	// so when a native window exists, it is prepared right after it is created. The first window created before the application runs is prepared
	// when the application starts.
	// The window is put on the screen transparent and made opaque when the first screen is displayed. Call Show outside the UI thread.
	var revealed sync.Once
	s.prepareNative = func() {
		place(nil)
		revealed.Do(func() {
			// The title bar keeps its initial height until the page requests the first row height. It is set before the window is visible.
			var titled error
			application.InvokeSync(func() { titled = system.SetTitlebarHeight(win.NativeWindow(), initialTitlebarHeight) })
			if titled != nil {
				LogError("window title bar", titled)
			}
			var failed error
			application.InvokeSync(func() { failed = system.RevealAfterLoad(win.NativeWindow()) })
			if failed != nil {
				fatalError("window reveal", failed)
			}
			win.Show()
		})
	}
	if win.NativeWindow() != nil {
		s.prepareNative()
	}
	// Tells the connections that watch host.window about changes of the window position, size, key state and occlusion state. Wails sends the occlusion
	// state change of macOS as WindowShow (visible) and WindowHide (completely covered).
	changed := func(*application.WindowEvent) {
		s.windowChanged()
		routine.Go("windows-changed", h.windowsChanged)
	}
	for event, kind := range map[events.WindowEventType]string{
		events.Common.WindowDidResize: "resize", events.Common.WindowDidMove: "move", events.Common.WindowFocus: "focus",
		events.Common.WindowLostFocus: "lost_focus", events.Common.WindowShow: "show", events.Common.WindowHide: "hide",
	} {
		win.OnWindowEvent(event, func(e *application.WindowEvent) {
			RecordWindowEvent(s.name, kind)
			changed(e)
		})
	}
	// The page reads state that no event announces, such as the registry index, when its window becomes active
	// (docs/spec/installation.md).
	win.OnWindowEvent(events.Common.WindowFocus, func(*application.WindowEvent) { s.Emit("window-active") })
	// The framework loads the page again after the WebContent process ends; the host writes the end as an error line
	// (docs/spec/diagnostics.md).
	win.OnWindowEvent(events.Mac.WebViewWebContentProcessDidTerminate, func(*application.WindowEvent) {
		RecordWindowEvent(s.name, "web_process_ended")
		if place, text, reported := PageProcessEnded(s.name, h.quit.Active()); reported {
			LogError(place, text)
		}
	})
	win.OnWindowEvent(events.Mac.WebViewDidCommitNavigation, func(*application.WindowEvent) {
		RecordWindowEvent(s.name, "navigation_committed")
		// This callback may run in a separate goroutine later than the calls of the new page. The cleanup of the previous page
		// is done by the start document request (startPage) of the new page, and here only the record of the WebKit children of this run is updated (V5-113).
		committed := func() {
			if h.workspace != nil {
				RefreshWebKitChildren(h.workspace.Directory())
			}
		}
		if handleNavigation != nil {
			handleNavigation(s, committed)
		} else {
			committed()
		}
	})
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		h.mu.Lock()
		ready := s.ready
		if !ready {
			delete(h.windows, win.ID())
			for id := range s.projects {
				delete(h.owners, id)
			}
		}
		quit := h.quit.Active() && len(h.windows) == 0
		h.mu.Unlock()
		if ready {
			RecordWindowEvent(s.name, "close_requested")
			e.Cancel()
			s.Emit("project-close-request")
			return
		}
		RecordWindowEvent(s.name, "closed")
		s.close()
		h.relay.Abandon(func(t relayTarget) bool { return t.owner == s })
		h.notifyWorkspace()
		routine.Go("windows-changed", h.windowsChanged)
		if quit {
			routine.Go("quit", application.Get().Quit)
		}
	})
	return s
}

func (h *Host) shouldQuit() bool {
	RecordAppEvent("exit_requested")
	h.mu.Lock()
	windows := make([]*Surfaces, 0, len(h.windows))
	unready := make([]*Surfaces, 0)
	for _, s := range h.windows {
		if s.ready {
			windows = append(windows, s)
		} else {
			unready = append(unready, s)
		}
	}
	if len(windows) > 0 {
		h.quit.Begin()
	}
	h.mu.Unlock()
	for _, s := range windows {
		s.Emit("project-close-request")
	}
	if len(windows) > 0 {
		for _, s := range unready {
			s.window.Close()
		}
	}
	return len(windows) == 0
}

// Chrome is the window values that the page uses to draw the first row. Controls is the region that the window buttons occupy and
// Row is the title bar height (pt). When there is no title bar, as in full screen, Row is 0.
type Chrome struct {
	Controls Rect    `json:"controls"`
	Row      float64 `json:"row"`
}

// WindowChrome returns the window button region and the title bar height. The page leaves room for the buttons in the first row and,
// when the title bar differs from the row, prepares a layout that contains the row (docs/spec/native-surfaces.md#title-bar-height).
func (s *Surfaces) WindowChrome() (Chrome, error) {
	controls, err := s.WindowControls()
	if err != nil {
		return Chrome{}, err
	}
	win, ok := s.window, s.window != nil
	if !ok {
		return Chrome{}, errNoWindow
	}
	var row float64
	var rowErr error
	application.InvokeSync(func() { row, rowErr = system.TitlebarHeight(win.NativeWindow()) })
	if rowErr != nil {
		return Chrome{}, rowErr
	}
	return Chrome{Controls: controls, Row: row}, nil
}

// initialTitlebarHeight is the title bar height (pt) set when a window is created. It equals the height of the first row at frame text scale 1
// (--chrome-h of packages/workbench/app.css).
const initialTitlebarHeight = 40

// ValidateTitlebarHeight checks the title bar height (pt) that a surface preparation carries. The first row is between 40pt and 108pt at frame text scale 3.
// AppKit uses a value of 0 or less to mean that there is no custom height, so such a value is also outside this range.
func ValidateTitlebarHeight(height float64) error {
	if math.IsNaN(height) || height < 32 || height > 200 {
		return errors.New("title bar height must be a finite number from 32 through 200 points")
	}
	return nil
}

// titlebarChrome sets the title bar of the window to height (pt) and returns the window button region and title bar height after that and the function that restores the previous height.
// A surface preparation calls it on the UI thread inside the layout transaction of the window, so the new height goes to the screen together with the commit of that transaction.
// A full screen window does not change the height, returns Row 0, and has nothing to restore.
func titlebarChrome(window unsafe.Pointer, height float64) (Chrome, func() error, error) {
	previous, err := system.TitlebarHeight(window)
	if err != nil {
		return Chrome{}, nil, err
	}
	restore := func() error {
		if previous <= 0 {
			return nil
		}
		return system.SetTitlebarHeight(window, previous)
	}
	if err := system.SetTitlebarHeight(window, height); err != nil {
		return Chrome{}, nil, err
	}
	controls, err := system.WindowControls(window)
	if err != nil {
		return Chrome{}, restore, err
	}
	row, err := system.TitlebarHeight(window)
	if err != nil {
		return Chrome{}, restore, err
	}
	return Chrome{Controls: Rect(controls), Row: row}, restore, nil
}

// StartTitlebarHeight is the height (pt) of the first row that the first draw of the page will show. It is round(max(40, 36 ×
// textSize)) for the common setting textSize, and 40 when the setting is missing (docs/spec/native-surfaces.md#title-bar-height). textSize is exclusive to the common settings, so
// the page draws the first row with the same value.
func StartTitlebarHeight(common Record) (float64, error) {
	value, has := common["textSize"]
	if !has {
		return initialTitlebarHeight, nil
	}
	factor, ok := value.(float64)
	if !ok {
		return 0, fmt.Errorf("common setting textSize must be a number, not %s", jsonKind(value))
	}
	if factor < 0.5 || factor > 3 {
		return 0, errors.New("common setting textSize must be from 0.5 through 3")
	}
	return math.Round(math.Max(initialTitlebarHeight, 36*factor)), nil
}

// startTitlebar sets the title bar of the window to the first row height of the common settings before it answers the start document. A new window that is not visible yet
// is set immediately, and a window that shows the previous page is set inside the start transaction of the new ticket and committed together with the first display of the new page
// (docs/spec/native-surfaces.md#title-bar-height). A full screen window does not change the height.
func (s *Surfaces) startTitlebar(common Record) error {
	height, err := StartTitlebarHeight(common)
	if err != nil {
		return err
	}
	win, ok := s.window, s.window != nil
	if !ok {
		return errNoWindow
	}
	done := make(chan error, 1)
	application.InvokeSync(func() {
		s.lastPreparation++
		if began := system.StartPageTitlebar(win.NativeWindow(), s.lastPreparation, height, func(failure error) { done <- failure }); began != nil {
			done <- began
		}
	})
	return <-done
}

// WindowControls returns the region that the window buttons occupy in page coordinates. The page leaves
// that much room in the first row. An empty region means that the window does not draw buttons.
func (s *Surfaces) WindowControls() (Rect, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return Rect{}, errNoWindow
	}
	var at Rect
	var err error
	application.InvokeSync(func() {
		var got platformRect
		got, err = system.WindowControls(win.NativeWindow())
		at = Rect(got)
	})
	return at, err
}

// close cleans up the native views, the input watch and the sidecar surfaces of a window when the window closes.
func (s *Surfaces) close() {
	// A window that ends keeps no tab, so a removal that asked it is allowed.
	s.host.removals.Abandon(s.name)
	application.InvokeSync(func() {
		cancelLayout(s.window)
		if s.monitor != 0 {
			system.UnwatchInput(s.monitor)
		}
		for _, view := range nativeViews {
			if view.owner == s {
				view.Close()
			}
		}
		// A logical surface is in s.views and not in nativeViews. A surface holds the main web view, so unless it is closed, the main
		// web view and its web content process remain.
		handles := make(map[string]unsafe.Pointer, len(s.views))
		views := make(map[unsafe.Pointer]*nativeWebview, len(s.views))
		for id, view := range s.views {
			handles[id] = view.handle
			views[view.handle] = view
		}
		err := CloseWindowSurfaces(handles, s.documents, s.images, func(native WindowNative) error {
			switch native.Kind {
			case WindowNativeDocument:
				system.CloseDocument(native.Handle)
			case WindowNativeImage:
				system.CloseImage(native.Handle)
			default:
				views[native.Handle].Close()
			}
			return nil
		})
		if err != nil {
			LogError("window close", err)
		}
		clear(s.views)
		clear(s.named)
		for _, shape := range s.shapes {
			shape.destroy()
		}
	})
	routine.Go("sidecars-close-owner", func() { s.sidecars.CloseOwner(s) })
}
