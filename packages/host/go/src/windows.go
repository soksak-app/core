// Project windows, the window registry, ready, close and termination handling, and the window state.

package host

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// windowTitle is the title of a window that has no open project.
func windowTitle() string { return "soksak" + titleSuffix() }

// titleSuffix is the end of the title of a project window.
func titleSuffix() string { return " / " + framework.DisplayName() }

// titleSetter is the native window of a window record, which holds the title of the window. NewSurfaces sets the real window,
// and a test sets a recorder in its place.
type titleSetter interface {
	SetTitle(title string)
}

// windowFront is the native window of a window record, which a project open or an activated notification shows. NewSurfaces
// sets the real window, and a test sets a recorder in its place.
type windowFront interface {
	Show()
	Focus()
	// IsFocused reports whether the window is the key window of the application.
	IsFocused() bool
}

// setTitle changes the window title and records it as the value that windows.list returns.
func (s *Surfaces) setTitle(title string) {
	s.mu.Lock()
	s.title = title
	s.mu.Unlock()
	s.titles.SetTitle(title)
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
	quit *Quit
	// steps runs the recording of the steps of the main thread.
	steps *stepRecording
	// update is the command of an application update or a relaunch that the shutdown starts; h.mu guards it.
	update     *pendingStart
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

// errWindowClosed is the failure of a request of the page that still runs when its window closes.
var errWindowClosed = errors.New("project window is closed")

// UseNativeWindow reads the native window of the window name with native in one step of the UI thread that invoke runs, and runs use with that window.
// The destroy of Wails closes the window on the UI thread and sets the native window to zero, so a window closed before that step
// is zero. For that window, it does not run use and returns the error 1003 of a window that does not exist. Native code does not receive a closed
// window.
func UseNativeWindow(invoke func(func()), name string, native func() platform.Window, use func(window platform.Window) error) error {
	var err error
	invoke(func() {
		window := native()
		if window == 0 {
			err = errMissingWindow(name)
			return
		}
		err = use(window)
	})
	return err
}

// useWindow runs use with the native window of this window in one step of the UI thread. A window that closed before that step gives 1003.
func (s *Surfaces) useWindow(use func(window platform.Window) error) error {
	return UseNativeWindow(mainThreadStep, s.name, s.window.NativeWindow, use)
}

// nativeError converts the error of an operation that used a native window to an error of code. The error 1003 of a closed window is left as it is.
func nativeError(code int, err error) error {
	var coded *RPCError
	if err == nil || errors.As(err, &coded) {
		return err
	}
	return rpcError(code, "%v", err)
}

func newHost(directory string, quit *Quit) (*Host, error) {
	h := &Host{quit: quit, workspace: NewWorkspace(directory), configDir: directory, windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{},
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
	win, ok := frontendOf(ctx)
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
	h.announceToWindows("debug-log-changed", notice)
	h.endpoint.NotifyWatchers("host.log", notice)
}

// announceToWindows sends the host event to every window; every document of a window receives it.
func (h *Host) announceToWindows(name string, payload any) {
	h.mu.Lock()
	windows := make([]*Surfaces, 0, len(h.windows))
	for _, s := range h.windows {
		windows = append(windows, s)
	}
	h.mu.Unlock()
	for _, s := range windows {
		s.Emit(name, payload)
	}
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
	if s.window.IsMaximized() || s.window.IsFullscreen() || s.window.IsMinimized() {
		return nil, nil
	}
	x, y := s.window.Position()
	width, height := s.window.Size()
	return &WindowGeometry{X: int32(math.Round(x)), Y: int32(math.Round(y)), Width: width, Height: height}, nil
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
	s.imageDetachPageReady()
	s.responderWorkbenchReady()
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

// ShowWindow puts a native window on the screen without taking the front from another application, for the show of a
// framework (docs/spec/hosts.md#launch-activation). The show asks for the registered platform: a framework shows a window
// whether or not the start of the host selected one.
func ShowWindow(window platform.Window) {
	current, err := platform.Current()
	if err != nil {
		fatalError("window show", err)
	}
	if err := current.ShowWindow(window); err != nil {
		fatalError("window show", err)
	}
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
	mainThreadStep(system.CancelQuitRequests)
	return nil
}

// prepareWindow fits the sizes of the content and the main web view of the window. Call it on the UI thread.
func prepareWindow(win Frontend) {
	if err := system.PrepareWindow(win.NativeWindow()); err != nil {
		LogError("window prepare", err)
	}
}

// cancelLayout cancels the surface layout in progress in the window. Call it on the UI thread.
func cancelLayout(s *Surfaces, win Frontend) {
	owner := win.NativeWindow()
	if err := system.EnqueueUI(func() {
		if err := s.cancelAllLayoutPresentations(owner); err != nil {
			LogError("surface layout cancel", err)
		}
	}); err != nil {
		LogError("surface layout cancel", err)
	}
}

// An app DOM reload replaces all plugin documents but does not end the sessions.
func (s *Surfaces) reloadSurfaceDocuments() ([]imageDetachTarget, error) {
	// The new main document registers its own sidecar receivers, and its views subscribe again.
	s.sidecarRoutes.clear()
	if s.invoke != nil {
		s.invoke(func() {
			if err := s.presentation.cancelAll(); err != nil {
				LogError("surface layout cancel", err)
			}
		})
	} else if err := s.presentation.cancelAll(); err != nil {
		LogError("surface layout cancel", err)
	}
	cancelLayout := s.reloadCancelLayout
	if cancelLayout == nil {
		cancelLayout = func() error { return system.CancelLayout(s.window.NativeWindow()) }
	}
	cancelErr := cancelLayout()
	// The workbench that owed the decision about the keyboard ended with its page, so the keys that wait for it go here, also
	// when the cancel failed (docs/spec/native-surfaces.md#keyboard-of-a-surface).
	keysPageEnded := s.reloadKeysPageEnded
	if keysPageEnded == nil {
		keysPageEnded = func() { system.KeysPageEnded(s.window.NativeWindow()) }
	}
	keysPageEnded()
	if cancelErr != nil {
		LogError("surface layout cancel", cancelErr)
		return nil, cancelErr
	}
	hideSurface := s.reloadHideSurface
	if hideSurface == nil {
		hideSurface = system.SetSurfaceHiddenHandle
	}
	closeImage := s.reloadCloseImage
	if closeImage == nil {
		closeImage = system.CloseImage
	}
	ids := make([]string, 0, len(s.views))
	var detachments []imageDetachTarget
	for id, view := range s.views {
		hideSurface(view.handle, true)
		// An element retains the view page, which would keep its process past the page.
		if s.elements.drawn {
			s.publishElement(id, SurfaceElement{})
		}
		s.closeSurfaceDocuments(id)
		detachments = append(detachments, s.reloadSurfaceImages(id, closeImage)...)
		ids = append(ids, id)
	}
	s.mu.Lock()
	clear(s.compositionRevisions)
	clear(s.compositions)
	clear(s.surfacePlugins)
	s.mu.Unlock()
	s.surfacesClosed(ids)
	s.windowChanged()
	return detachments, nil
}

// reloadSurfaceImages captures the current supplier and image generation before closing native image regions and advancing the surface generation.
func (s *Surfaces) reloadSurfaceImages(surface string, closeImage func(unsafe.Pointer)) []imageDetachTarget {
	targets := s.images.detachments(surface)
	s.images.CloseSurface(surface, closeImage)
	s.images.BeginGeneration(surface)
	return targets
}

// newWindow runs the window creation on the UI thread in a state in which the window registry lock is released.
func (h *Host) newWindow(name, url string) *Surfaces {
	// The window is shown after the first screen is displayed (docs/spec/native-host.md#page-start). When the preparation ends, reveal shows it.
	win := framework.NewWindow(WindowOptions{Name: name, Title: windowTitle(), URL: url, Width: startWidth, Height: startHeight})
	s := NewSurfaces(win, h.sidecars)
	s.host, s.name, s.title = h, name, windowTitle()
	if frames := win.Frames(); frames != nil {
		// The status of the window changes with a frame, as whether it is occluded does with the screen. A frame runs here, so
		// a window that nobody watches pays for no reading.
		frames.OnSettled(func() {
			if h.endpoint != nil && h.endpoint.Watching(s.name, "host.window") {
				s.windowChanged()
			}
		})
	}
	h.mu.Lock()
	h.windows[win.ID()] = s
	h.mu.Unlock()
	PerformanceWindowAdd(name, s.performanceProcesses)
	routine.Go("windows-changed", h.windowsChanged)
	// The native view is placed over the DOM, so the page handles a dropped file based on the DOM element at that point.
	var dropOnce sync.Once
	place := func() {
		if !framework.MainPage() {
			return
		}
		mainThreadStep(func() {
			// A window that closed still reports a resize or a show, as one that leaves full screen while a quit closes it does. Its
			// main web view has left the window, and a placement would fail and end the process before the quit finishes.
			if s.closed {
				return
			}
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
	win.OnWindowEvent(WindowResize, place)
	win.OnWindowEvent(WindowShow, place)
	// WindowShow arrives when the occlusion state of the window changes to visible. It does not arrive for a window that was opened while completely covered by the window of another application,
	// so when a native window exists, it is prepared right after it is created. The first window created before the application runs is prepared
	// when the application starts.
	// The window is put on the screen transparent and made opaque when the first screen is displayed. Call Show outside the UI thread.
	var revealed sync.Once
	s.elements.drawn = !framework.MainPage()
	s.prepareNative = func() {
		place()
		revealed.Do(func() {
			// The title bar keeps its initial height until the page requests the first row height. It is set before the window is visible.
			var titled error
			mainThreadStep(func() { titled = system.SetTitlebarHeight(win.NativeWindow(), initialTitlebarHeight) })
			if titled != nil {
				LogError("window title bar", titled)
			}
			// The workbench combines the first responder with the focus of its documents in core.focus.
			var observed error
			mainThreadStep(func() {
				s.responderObservation, observed = system.ObserveResponder(win.NativeWindow(), s.responderChanged)
			})
			if observed != nil {
				fatalError("window responder", observed)
			}
			if framework.MainPage() {
				var failed error
				mainThreadStep(func() { failed = system.RevealAfterLoad(win.NativeWindow()) })
				if failed != nil {
					fatalError("window reveal", failed)
				}
			}
			win.Show()
		})
	}
	if win.NativeWindow() != 0 {
		s.prepareNative()
	}
	// Tells the connections that watch host.window about changes of the window position, size, key state and occlusion state. A framework sends the occlusion
	// state change of macOS as WindowShow (visible) and WindowHide (completely covered).
	changed := func() {
		// An occluded or minimized window draws no image region (docs/spec/native-surfaces.md#image-regions).
		mainThreadStep(func() {
			// A window that closes still reports changes, and it has no state left to read.
			if win.NativeWindow() != 0 {
				if err := s.readOnScreen(); err != nil {
					LogError("window on screen", err)
				}
			}
		})
		routine.Go("image-drawing", func() {
			if err := s.sendImageDrawing(); err != nil {
				LogError("image drawing", err)
			}
		})
		s.windowChanged()
		routine.Go("windows-changed", h.windowsChanged)
	}
	for event, kind := range map[WindowEvent]string{
		WindowResize: "resize", WindowMove: "move", WindowFocus: "focus",
		WindowFocusLost: "lost_focus", WindowShow: "show", WindowHide: "hide",
	} {
		win.OnWindowEvent(event, func() {
			RecordWindowEvent(s.name, kind)
			changed()
		})
	}
	// The page reads state that no event announces, such as the registry index, when its window becomes active
	// (docs/spec/installation.md).
	win.OnWindowEvent(WindowFocus, func() {
		RecordWindowEvent(s.name, "window-active")
		s.Emit("window-active")
	})
	// A frame of the earlier backing scale is refused, so each supplier draws at the new raster when the window changes display.
	win.OnWindowEvent(WindowScaleChanged, func() {
		RecordWindowEvent(s.name, "scale_factor_changed")
		routine.Go("image-rasters", func() {
			if err := s.refreshImageRasters(); err != nil {
				LogError("image rasters", err)
			}
		})
	})
	// The framework loads the page again after the WebContent process ends; the host writes the end as an error line
	// (docs/spec/diagnostics.md).
	win.OnWindowEvent(WindowWorkbenchEnded, func() {
		RecordWindowEvent(s.name, "web_process_ended")
		if place, text, reported := PageProcessEnded(s.name, h.quit.Active()); reported {
			LogError(place, text)
		}
		// The workbench ended with the process of its page, so the keys that wait for its decision go.
		s.mainPageEnded()
		// The page that a removal asked ended, so the removal is allowed (docs/spec/projects.md).
		h.removals.Abandon(s.name)
	})
	win.OnWindowEvent(WindowWorkbenchCommitted, func() {
		RecordWindowEvent(s.name, "navigation_committed")
	})
	win.OnClosing(func() bool {
		h.mu.Lock()
		ready := s.ready
		if !ready {
			delete(h.windows, win.ID())
			PerformanceWindowRemove(s.name)
			for id := range s.projects {
				delete(h.owners, id)
			}
		}
		quit := h.quit.Active() && len(h.windows) == 0
		h.mu.Unlock()
		if ready {
			RecordWindowEvent(s.name, "close_requested")
			s.Emit("project-close-request")
			return true
		}
		RecordWindowEvent(s.name, "closed")
		s.close()
		h.relay.Abandon(func(t relayTarget) bool { return t.owner == s })
		h.notifyWorkspace()
		routine.Go("windows-changed", h.windowsChanged)
		if quit {
			QuitWithCause("last-window-closed", HostQuitSource("last-window-closed"), func() { routine.Go("quit", framework.Quit) })
		}
		return false
	})
	return s
}

// quitEventType is the type of the event that the application handles now, which names a quit of the menu or a key
// equivalent; -1 when the platform cannot be read.
func quitEventType() int {
	current, err := platform.Current()
	if err != nil {
		fmt.Fprintf(os.Stderr, "exit request: the current event cannot be read: %v\n", err)
		return -1
	}
	return current.QuitEventType()
}

func (h *Host) shouldQuit() bool {
	RecordAppEvent("exit_requested")
	EmitExitRequest(quitEventType)
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
	quitNow := h.quit.BeginRequest(len(windows))
	h.mu.Unlock()
	for _, s := range windows {
		s.Emit("project-close-request")
	}
	if len(windows) > 0 {
		for _, s := range unready {
			s.window.Close()
		}
	}
	return quitNow
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
	mainThreadStep(func() { row, rowErr = system.TitlebarHeight(win.NativeWindow()) })
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
func titlebarChrome(window platform.Window, height float64) (Chrome, func() error, error) {
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
	// A window without a main page has no first row to wait for: a window that shows no frame yet takes the row at once
	// (startWorkbenchTitlebar), and the workbench gives each later row with its layout. A quit closes the last window while its start
	// runs, and the close ends the window on the main thread, so the step of a start that comes after it leaves the native window
	// alone and names no window.
	if s.elements.drawn {
		var set error
		mainThreadStep(func() {
			if s.closed {
				set = ErrNoStartWindow
				return
			}
			set = system.SetTitlebarHeight(win.NativeWindow(), height)
		})
		return set
	}
	done := make(chan error, 1)
	mainThreadStep(func() {
		if s.closed {
			done <- ErrNoStartWindow
			return
		}
		s.lastPreparation++
		if began := system.StartPageTitlebar(win.NativeWindow(), s.lastPreparation, height, func(failure error) { done <- failure }); began != nil {
			done <- began
		}
	})
	return <-done
}

// startWorkbenchTitlebar is the title bar step of the start of a workbench without a main page. A window that shows no frame yet takes
// the row of the common settings at once (startTitlebar). A window that shows the last frame of its previous workbench (shown) keeps
// the title bar of that frame, which it holds until the first screen of the new workbench: the row of that screen goes to the window
// with its layout, as each later row does, since the frame held may show another row than the settings, as when another window
// changed them and the previous workbench did not draw that change. The setting is checked either way.
func (s *Surfaces) startWorkbenchTitlebar(common Record, shown bool) error {
	if !shown {
		return s.startTitlebar(common)
	}
	_, err := StartTitlebarHeight(common)
	return err
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
	mainThreadStep(func() {
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
	mainThreadStep(func() {
		s.closed = true
		cancelLayout(s, s.window)
		// The close ends the observation and not the window, which Wails may have released.
		system.EndResponderObservation(s.responderObservation)
		s.responderObservation = nil
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
			// A view of the surface ends with its window (docs/spec/logging.md#principles).
			s.viewRecords().recordEnd(id)
			// An element retains the surface host and the web view of the view page, so it leaves before they close and hands
			// them back after the frame that the closed window can no longer present.
			if s.elements.drawn {
				s.publishElement(id, SurfaceElement{})
			}
		}
		err := CloseWindowSurfaces(handles, s.documents, s.streams, s.images, func(native WindowNative) error {
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
	// The window closed, so the producer of every watch of it ended (docs/spec/exposure.md#methods).
	if s.host.endpoint != nil {
		s.host.endpoint.ProducerEnded(s.name, "", "window-closed")
	}
}
