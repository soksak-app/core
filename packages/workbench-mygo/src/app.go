package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// The workbench of the mygo application: one shell for each window, connected to the host through the Workbench port of the
// framework adapter (docs/spec/hosts.md#workbench).

// The codes of an exposure reply, as EXPOSURE_ERRORS of packages/plugin-api declares them.
const (
	codeFailed        = -32000
	codeUnknownMethod = -32601
	codeUnknownName   = 1001
	codeUnregistered  = 1002
)

// Painted is what the workbench needs of a window beyond the Frontend port: asking for a frame.
type Painted interface {
	Invalidate()
}

// AppOptions is what the application gives the workbench.
type AppOptions struct {
	// Environment is the text of the environment declaration.
	Environment []byte
	// Post runs a task as a later step of the main thread.
	Post func(task func())
	// Table returns the host calls of a window.
	Table func(window host.Frontend) map[string]HostCall
	// Report writes a line of a shown error to the application log.
	Report func(line string)
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
	shell, err := NewShell(ShellOptions{Declared: declared, Calls: NewCalls(a.options.Table(window), a.options.Post),
		Environment: a.options.Environment, Invalidate: window.(Painted).Invalidate, Post: a.options.Post, Report: a.options.Report})
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
	defer a.mu.Unlock()
	delete(a.shells, window)
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
		shell.event(name, data)
	})
}

// Call delivers a call of the workbench call channel. The native workbench draws the state of a call as an event.
func (a *App) Call(window host.Frontend, script string) {}

// exposureRequest is the data of the event exposure-request.
type exposureRequest struct {
	ID     uint64 `json:"id"`
	Method string `json:"method"`
	Params struct {
		Name   string          `json:"name"`
		Params json.RawMessage `json:"params"`
	} `json:"params"`
}

// event handles an event of the host in a step of the main thread.
func (s *Shell) event(name string, data []any) {
	switch name {
	case "exposure-request":
		if len(data) != 1 {
			s.fail(errors.New("exposure-request carries one value"))
			return
		}
		request, err := decode[exposureRequest](data[0])
		if err != nil {
			s.fail(err)
			return
		}
		s.answerExposure(request)
	}
}

// exposureFailure is an error with the code of its reply.
type exposureFailure struct {
	code int
	err  error
}

func (s *Shell) answerExposure(request exposureRequest) {
	reply := map[string]any{"id": request.ID}
	result, failure := s.exposure(request)
	if failure != nil {
		reply["error"] = map[string]any{"code": failure.code, "message": failure.err.Error()}
	} else {
		reply["result"] = result
	}
	s.calls.Call("exposureReply", reply, func(_ any, err error) {
		if err != nil {
			s.fail(err)
		}
	})
}

// exposure answers a request of the endpoint from the registry of the window.
func (s *Shell) exposure(request exposureRequest) (any, *exposureFailure) {
	failed := func(err error) (any, *exposureFailure) { return nil, &exposureFailure{codeFailed, err} }
	switch request.Method {
	case "exposure.list":
		return s.exposureList(), nil
	case "command.run":
		name := request.Params.Name
		if !s.options.Declared.Commands[name] {
			return nil, &exposureFailure{codeUnknownName, errors.New("unknown command " + name)}
		}
		commands, _ := s.registry.Names()
		if !contains(commands, name) {
			return nil, &exposureFailure{codeUnregistered, errors.New("command " + name + " is not registered")}
		}
		result, err := s.registry.Run(name, request.Params.Params)
		if err != nil {
			return failed(err)
		}
		return result, nil
	case "status.get":
		name := request.Params.Name
		if !s.options.Declared.Statuses[name] {
			return nil, &exposureFailure{codeUnknownName, errors.New("unknown status " + name)}
		}
		_, statuses := s.registry.Names()
		if !contains(statuses, name) {
			return nil, &exposureFailure{codeUnregistered, errors.New("status " + name + " is not registered")}
		}
		value, err := s.registry.Read(name)
		if err != nil {
			return failed(err)
		}
		return value, nil
	}
	return nil, &exposureFailure{codeUnknownMethod, errors.New("unknown method " + request.Method)}
}

func contains(names []string, name string) bool {
	for _, known := range names {
		if known == name {
			return true
		}
	}
	return false
}

// exposureList is the declaration with registered on each entry, the form of exposure.list.
func (s *Shell) exposureList() map[string]any {
	commands, statuses := s.registry.Names()
	list := s.options.Declared.ExposureEntries()
	mark := func(entries []map[string]any, registered []string) {
		for _, entry := range entries {
			name, _ := entry["name"].(string) // silent: the declaration test holds the name of every entry.
			entry["registered"] = contains(registered, name)
		}
	}
	mark(list["status"], statuses)
	mark(list["commands"], commands)
	return map[string]any{"status": list["status"], "commands": list["commands"], "dom": list["dom"]}
}
