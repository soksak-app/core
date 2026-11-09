package workbench

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// The workbench of the mygo application: one shell for each window, connected to the host through the Workbench port of the
// framework adapter (docs/spec/hosts.md#workbench).

// Painted is what the workbench needs of a window beyond the Frontend port: asking for a frame and its elements.
type Painted interface {
	Invalidate()
	Elements
	// Address returns the address of the window, which keeps the project that it shows over a start of the workbench.
	Address() string
	// SetAddress sets the address of the window.
	SetAddress(address string)
	// Visible tells whether the window shows, which it does not while it is minimized or not shown.
	Visible() bool
	// ContentSize is the content size of the window in points.
	ContentSize() (width, height float64)
	// Scale is the backing scale of the window.
	Scale() (float64, error)
	// SetBackdrop sets the color of the window behind its content.
	SetBackdrop(color string) error
	// FirstScreen tells the window that its workbench shows its first screen, so a reloaded window draws again.
	FirstScreen()
	// OpenLayout opens the surface layout transaction of the window for the frame being drawn and returns its ticket, or 0 while a
	// layout transaction holds the frames of the window (docs/spec/hosts.md#native-views).
	OpenLayout() (uint64, error)
}

// projectOfAddress returns the project that a window address names, and "" without one.
func projectOfAddress(address string) string {
	parsed, err := url.Parse(address)
	if err != nil {
		return "" // silent: the host writes the address, and a window without a readable one starts at the library.
	}
	return parsed.Query().Get("project")
}

// addressOfProject returns the address of a window that shows project, and of a window that shows none when it is "".
func addressOfProject(project string) string {
	if project == "" {
		return "/"
	}
	return "/?project=" + url.QueryEscape(project)
}

// AppOptions is what the application gives the workbench.
type AppOptions struct {
	// Environment is the text of the environment declaration.
	Environment []byte
	// Post runs a task as a later step of the main thread.
	Post func(task func())
	// Table returns the host calls of a window.
	Table func(window host.Frontend) map[string]HostCall
	// Report writes a failure of the event writer to the application log.
	Report func(line string)
	// Installed reads the document of the installed plugins.
	Installed func() []byte
	// Element returns the views of the surface id of window for its native view element.
	Element func(window host.Frontend, id string) (surface, key uintptr, ok bool)
	// Detaching returns the surfaces of window whose image detach is pending.
	Detaching func(window host.Frontend) []string
	// Clock is the time of the tab parts, and nil the time of the system.
	Clock TabClock
}

// TabClock is the time that the tab parts read: a monotonic time in milliseconds, and a timer that runs in a later step of the main thread.
type TabClock interface {
	Now() int64
	After(milliseconds int64, run func()) (cancel func())
}

// App is the workbench of the application.
type App struct {
	options AppOptions
	mu      sync.Mutex
	shells  map[host.Frontend]*Shell
}

// NewApp returns the workbench of the application.
func NewApp(options AppOptions) (*App, error) {
	if _, err := Declared(); err != nil {
		return nil, err
	}
	return &App{options: options, shells: map[host.Frontend]*Shell{}}, nil
}

// HostElement returns the views of a surface of a window of h for its native view element.
func HostElement(h *host.Host) func(window host.Frontend, id string) (uintptr, uintptr, bool) {
	return func(window host.Frontend, id string) (uintptr, uintptr, bool) {
		element, ok := host.ElementOf(h, window, id)
		return uintptr(element.Surface), uintptr(element.Key), ok
	}
}

// HostDetaching returns the surfaces of a window of h whose image detach is pending.
func HostDetaching(h *host.Host) func(window host.Frontend) []string {
	return func(window host.Frontend) []string { return host.DetachingSurfaces(h, window) }
}

// HostTable is the table of the calls of the host for a window of the application.
func HostTable(h *host.Host) func(window host.Frontend) map[string]HostCall {
	return func(window host.Frontend) map[string]HostCall {
		table := hostCalls(h)
		bound := make(map[string]HostCall, len(table))
		for name, call := range table {
			bound[name] = func(ctx context.Context, argument json.RawMessage) (any, error) {
				return call(host.WithFrontend(ctx, window), argument)
			}
		}
		return bound
	}
}

// Build builds the workbench of window and returns its view.
func (a *App) Build(window host.Frontend) func(c *ui.Context) {
	declared, err := Declared()
	if err != nil {
		panic(err) // NewApp read the same embedded declarations.
	}
	painted := window.(Painted)
	shell, err := NewShell(ShellOptions{Now: time.Now, Declared: declared, Calls: NewCalls(a.options.Table(window), a.options.Post),
		Environment: a.options.Environment, Installed: a.options.Installed(),
		Reload:      func() { routine.Go("workbench-reload", window.StartWorkbench) },
		Detaching:   func() []string { return a.options.Detaching(window) },
		Project:     projectOfAddress(painted.Address()),
		Located:     func(project string) { painted.SetAddress(addressOfProject(project)) },
		Backdrop:    painted.SetBackdrop,
		FirstScreen: painted.FirstScreen,
		OpenLayout:  painted.OpenLayout,
		Element:     func(id string) (uintptr, uintptr, bool) { return a.options.Element(window, id) }, Invalidate: painted.Invalidate, Elements: painted, Post: a.options.Post, Report: a.options.Report,
		Tabs: a.tabPorts, Window: func() (WindowView, error) {
			scale, err := painted.Scale()
			if err != nil {
				return WindowView{}, err
			}
			width, height := painted.ContentSize()
			return WindowView{Visible: painted.Visible(), Scale: scale, Width: width, Height: height}, nil
		}})
	if err != nil {
		panic(err) // The environment declaration is staged with the application, and its test holds its form.
	}
	a.mu.Lock()
	a.shells[window] = shell
	a.mu.Unlock()
	return shell.View
}

// After runs run once in a step of the main thread after milliseconds, and returns what cancels it. The cancel runs on the main
// thread too, so a timer that fired and waits for its step does not run after it.
func (a *App) After(milliseconds int64, run func()) (cancel func()) {
	cancelled := false
	timer := time.AfterFunc(time.Duration(milliseconds)*time.Millisecond, func() {
		a.options.Post(func() {
			if !cancelled {
				run()
			}
		})
	})
	return func() {
		cancelled = true
		timer.Stop()
	}
}

// Close ends the workbench of window.
func (a *App) Close(window host.Frontend) {
	a.mu.Lock()
	shell := a.shells[window]
	delete(a.shells, window)
	a.mu.Unlock()
	if shell != nil {
		shell.calls.End()
		shell.events.End()
		a.options.Post(shell.Closed)
	}
}

func (a *App) shell(window host.Frontend) *Shell {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.shells[window]
}

// Shown starts the workbench of window, whose host calls the host now answers.
func (a *App) Shown(window host.Frontend) {
	a.options.Post(func() {
		if shell := a.shell(window); shell != nil {
			shell.Start()
		}
	})
}

// StartFailed ends the start of window that the host refused with err.
func (a *App) StartFailed(window host.Frontend, err error) {
	a.options.Post(func() {
		if shell := a.shell(window); shell != nil {
			shell.StartFailed(err)
		}
	})
}

// Emit delivers an event to the workbench of window in a step of the main thread.
func (a *App) Emit(window host.Frontend, name string, data ...any) {
	a.options.Post(func() {
		shell := a.shell(window)
		if shell == nil {
			return
		}
		shell.Event(name, data)
	})
}

// Call delivers a call of the workbench call channel. The native workbench draws the state of a call as an event.
func (a *App) Call(window host.Frontend, script string) {}

// pluginsChanged follows the event plugins-changed: a shell that started reads the plugin state again and applies the change; a change
// before the start waits for it, because the apply saves the projects (docs/spec/installation.md#applying-a-change).
func (s *Shell) pluginsChanged() {
	if !s.started {
		s.changed = true
		return
	}
	s.pluginOperations.Refresh(func() {
		s.pluginOperations.RefreshOutdated(func() { s.applyPlugins(func(bool, error) {}) })
	})
}

// applyPlugins applies a change of the installed plugins to the window: it asks about each modified tab, and when no tab was kept it
// saves the projects, answers done reloaded true and starts the workbench again once the host took every reply, so it loads the
// plugins that installed.json lists. A kept tab keeps the workbench and answers reloaded false. At most one apply runs: a change during
// it is answered by it and makes one more apply due, which runs after a kept workbench when the plugin state still differs; a new
// start reads the state again.
func (s *Shell) applyPlugins(done func(reloaded bool, err error)) {
	s.applied = append(s.applied, done)
	if s.applying {
		s.applyDue = true
		return
	}
	s.applying = true
	s.settleModified(applyAnswers, func(settled bool) {
		if !settled {
			s.appliedWith(false, nil)
			return
		}
		s.keep()
		s.flushTabs(func() {
			s.events.Flush(func() {
				s.calls.CallInOrder("workspace", "workspace", map[string]string{"kind": "snapshot"}, func(_ any, err error) {
					if err != nil {
						s.fail(err)
						s.appliedWith(false, err)
						return
					}
					s.answerApplied(true, nil)
					s.requests.Answered(s.options.Reload)
				})
			})
		})
	})
}

// answerApplied gives the result of the running apply to each caller that waits for it.
func (s *Shell) answerApplied(reloaded bool, err error) {
	waiting := s.applied
	s.applied = nil
	for _, done := range waiting {
		done(reloaded, err)
	}
}

// appliedWith ends an apply that kept the workbench, and runs the due apply when the plugin state still differs.
func (s *Shell) appliedWith(reloaded bool, err error) {
	s.applying = false
	s.answerApplied(reloaded, err)
	if s.applyDue {
		s.applyDue = false
		if s.pluginOperations.Status().Reload {
			s.applyPlugins(func(bool, error) {})
		}
	}
}

// Event handles an event of the host in a step of the main thread.
func (s *Shell) Event(name string, data []any) { s.event(name, data) }

// event handles an event of the host in a step of the main thread.
func (s *Shell) event(name string, data []any) {
	switch name {
	case "exposure-request":
		if !s.viewExposure(data) {
			s.requests.Deliver(data...)
		}
	case "exposure-registered":
		s.surfaceRegistered(data)
	case "view-call":
		s.viewCall(data)
	case "view-reply":
		s.viewReplied(data)
	case "view-process-ended":
		s.viewEnded(data)
	case "view-stopped":
		s.viewStopped(data)
	case "view-responsiveness":
		s.viewResponsiveness(data)
	case "view-presentation-abandoned":
		s.presentationAbandoned(data)
	case "document-stream", "document-state", "document-message", "image-event":
		if name == "document-state" {
			s.documentState(data)
		}
		s.viewEvent(name, data)
	case "sidecar-failure":
		s.sidecarFailed(data)
	case "surface-pressed":
		s.surfacePressed(data)
	case "plugins-changed":
		s.pluginsChanged()
	case "image-detach-ended":
		s.imageDetachEnded(data)
	case "sidecars-changed":
		s.pluginOperations.RefreshOutdated(func() {})
	case "window-active":
		s.pluginOperations.Refresh(func() {})
		s.appUpdates.Refresh()
	case "project-close-request":
		s.closeWindowAsked()
	case "project-remove-request":
		s.removalAsked(data)
	case "menu-command":
		s.menuCommand(data)
	case "debug-save-progress", "debug-save-done", "debug-log-changed":
		s.debugEvent(name, data)
	case "log-policy":
		s.events.Follow(data...)
		s.followLogLevels(data)
	case "workspace-changed":
		s.workspaceChanged()
	case "files-dropped":
		s.filesDropped(data)
	case "window-responder":
		s.windowResponder(data)
	default:
		if !s.noticeEvent(name, data) {
			s.tabEvent(name, data)
			s.eventLeft(name)
		}
	}
}

// menuCommand runs the command of a menu item, whose failure the window shows.
func (s *Shell) menuCommand(data []any) {
	item, err := eventBody[struct {
		Name string `json:"name"`
	}]("menu-command", data)
	if err != nil {
		s.fail(err)
		return
	}
	s.binder.run(item.Name, nil)
}

// windowResponder follows the first responder of the window.
func (s *Shell) windowResponder(data []any) {
	responder, err := eventBody[Responder]("window-responder", data)
	if err == nil {
		err = s.exposedFocus.SetResponder(responder)
	}
	if err != nil {
		s.fail(err)
		return
	}
	s.keyboardLeft(responder)
}

// eventBody reads the one value of the event name.
func eventBody[T any](name string, data []any) (T, error) {
	var body T
	if len(data) != 1 {
		return body, fmt.Errorf("the event %s holds %d values", name, len(data))
	}
	body, err := decode[T](data[0])
	if err != nil {
		return body, fmt.Errorf("the event %s: %w", name, err)
	}
	return body, nil
}

// eventsLeft are the events of the host that a window of this workbench leaves, because nothing it draws reads them.
var eventsLeft = map[string]bool{"diagnostics-tick": true, "diagnostics-unlistened": true, "document-event": true,
	"document-message": true, "document-state": true, "document-stream": true, "exit-request": true, "exposure-registered": true,
	"image-event": true, "log-policy": true, "memory-pressure": true, "modal-content": true,
	"modal-position": true, "modal-rendered": true, "overlay-pick": true, "page-ready": true, "plugins-changed": true, "project-activate": true,
	"run-began": true, "run-ended": true, "sidecar-failure": true, "sidecar-message": true, "sidecars-changed": true, "surface-input": true,
	"surface-pressed": true, "theme": true, "view-call": true, "view-process-ended": true,
	"view-reply": true, "view-source-ended": true, "view-source-registered": true, "view-stopped": true,
	"window-active": true}

// eventLeft writes an event that no part of the workbench knows to the application log. The host names notification events by type.
func (s *Shell) eventLeft(name string) {
	if !eventsLeft[name] && !strings.HasPrefix(name, "notification-") {
		s.events.Error(fmt.Sprintf("host event: the host sent the unknown event %s", name))
	}
}
