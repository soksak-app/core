package workbench

import (
	"context"
	"encoding/json"
	"sync"

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
	shell, err := NewShell(ShellOptions{Declared: declared, Calls: NewCalls(a.options.Table(window), a.options.Post),
		Environment: a.options.Environment, Installed: a.options.Installed(),
		Reload:  func() { routine.Go("workbench-reload", window.StartWorkbench) },
		Element: func(id string) (uintptr, uintptr, bool) { return a.options.Element(window, id) }, Invalidate: painted.Invalidate, Elements: painted, Post: a.options.Post, Report: a.options.Report})
	if err != nil {
		panic(err) // The environment declaration is staged with the application, and its test holds its form.
	}
	a.mu.Lock()
	a.shells[window] = shell
	a.mu.Unlock()
	return shell.View
}

// Close ends the workbench of window.
func (a *App) Close(window host.Frontend) {
	a.mu.Lock()
	shell := a.shells[window]
	delete(a.shells, window)
	a.mu.Unlock()
	if shell != nil {
		shell.events.End()
		a.options.Post(shell.flushTabs)
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

// pluginsChanged applies a change of the installed plugins: the workbench saves the projects and starts again, so it loads the plugins
// that installed.json lists (docs/spec/installation.md#applying-a-change). A shell follows the change once it started, and one reload
// covers every change before it, because the new workbench reads the state again.
func (s *Shell) pluginsChanged() {
	if !s.started {
		s.changed = true
		return
	}
	if s.reloading {
		return
	}
	s.reloading = true
	s.keep()
	s.flushTabs()
	s.events.Flush(func() {
		s.calls.CallInOrder("workspace", "workspace", map[string]string{"kind": "snapshot"}, func(_ any, err error) {
			if err != nil {
				s.reloading = false
				s.fail(err)
				return
			}
			s.options.Reload()
		})
	})
}

// Event handles an event of the host in a step of the main thread.
func (s *Shell) Event(name string, data []any) {
	switch name {
	case "exposure-request":
		if !s.viewExposure(data) {
			s.requests.Deliver(data...)
		}
	case "view-call":
		s.viewCall(data)
	case "view-reply":
		s.viewReplied(data)
	case "view-process-ended":
		s.viewEnded(data)
	case "view-stopped":
		s.viewStopped(data)
	case "document-stream", "document-state", "document-message", "image-event":
		s.viewEvent(name, data)
	case "sidecar-failure":
		s.sidecarFailed(data)
	case "surface-pressed":
		s.surfacePressed(data)
	case "plugins-changed":
		s.pluginsChanged()
	case "project-close-request":
		s.keep()
		s.flushTabs()
		s.events.Flush(func() {
			s.calls.CallInOrder("workspace", "windowClose", nil, func(_ any, err error) {
				if err != nil {
					s.fail(err)
				}
			})
		})
	case "log-policy":
		s.events.Follow(data...)
	case "workspace-changed":
		s.workspaceChanged()
	case "files-dropped":
		s.filesDropped(data)
	default:
		if !s.noticeEvent(name, data) {
			s.tabEvent(name, data)
		}
	}
}
