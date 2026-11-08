package workbench

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// HostCall runs one handler of the host with its argument as JSON.
type HostCall func(ctx context.Context, argument json.RawMessage) (any, error)

// hostCalls is the one table through which the workbench calls the host handlers of the language host library
// (docs/spec/hosts.md#workbench). Its names are the names of METHOD of the Wails runtime and of COMMAND of the Tauri runtime, except
// the calls that a row B of the framework table lists as absent on mygo or only on mygo.
func hostCalls(h *host.Host) map[string]HostCall {
	return map[string]HostCall{
		"workspace":                request(h.Workspace),
		"windowNew":                run(h.WindowNew),
		"folderChoose":             readOf(h.FolderChoose),
		"projectCreate":            request(h.ProjectCreate),
		"projectFolder":            request(h.ProjectFolder),
		"projectOpen":              answerOf(h.ProjectOpen),
		"projectShown":             doneOf(h.ProjectShown),
		"projectRelease":           send(h.ProjectRelease),
		"projectRemoveAsk":         answerOf(h.ProjectRemoveAsk),
		"projectRemoveAnswer":      send(h.ProjectRemoveAnswer),
		"windowState":              readOf(h.WindowState),
		"windowReady":              actOf(h.WindowReady),
		"windowClose":              actOf(h.WindowClose),
		"windowCloseKept":          actOf(h.WindowCloseKept),
		"appUpdateState":           readOf(h.AppUpdateState),
		"appUpdateStage":           answerOf(h.AppUpdateStage),
		"appUpdateApply":           doneOf(h.AppUpdateApply),
		"syncSurfaces":             answerOf(h.SyncSurfaces),
		"presentSurfaces":          answerOf(h.PresentSurfaces),
		"cancelSurfaces":           doneOf(h.CancelSurfaces),
		"surfaceFocus":             doneOf(h.SurfaceFocus),
		"keyboardHold":             actOf(h.KeyboardHold),
		"keyboardDecided":          actOf(h.KeyboardDecided),
		"waitPresented":            readOf(h.WaitPresented),
		"setTheme":                 doneOf(h.SetTheme),
		"setMenuLanguage":          doneOf(h.SetMenuLanguage),
		"setDialogBackground":      doneOf(h.SetDialogBackground),
		"theme":                    readOf(h.Theme),
		"windowControls":           readOf(h.WindowControls),
		"exposureReply":            doneOf(h.ExposureReply),
		"exposureChanged":          doneOf(h.ExposureChanged),
		"exposureForward":          answerOf(h.ExposureForward),
		"exposureRegister":         doneOf(h.ExposureRegister),
		"compositionDeclare":       doneOf(h.CompositionDeclare),
		"performance":              request(h.Performance),
		"log":                      answerOf(h.Log),
		"compositionPlace":         doneOf(h.CompositionPlace),
		"imageAttach":              doneOf(h.ImageAttach),
		"imageFocus":               doneOf(h.ImageFocus),
		"imageDetach":              doneOf(h.ImageDetach),
		"documentAttach":           doneOf(h.DocumentAttach),
		"documentLoad":             doneOf(h.DocumentLoad),
		"documentZoom":             doneOf(h.DocumentZoom),
		"documentGo":               answerOf(h.DocumentGo),
		"documentQuery":            answerOf(h.DocumentQuery),
		"documentInteractionState": answerOf(h.DocumentInteractionState),
		"documentPost":             doneOf(h.DocumentPost),
		"viewEvent":                answerOf(h.ViewEvent),
		"viewReply":                doneOf(h.ViewReply),
		"viewRequest":              answerOf(h.ViewRequest),
		"viewSidecarRoute":         doneOf(h.ViewSidecarRoute),
		"viewSidecarSend":          doneOf(h.ViewSidecarSend),
		"sidecarListen":            doneOf(h.SidecarListen),
		"viewSourceOrigins":        readOf(h.ViewSourceOrigins),
		"documentDetach":           doneOf(h.DocumentDetach),
		"documentSubscribe":        answerOf(h.DocumentSubscribe),
		"documentUnsubscribe":      doneOf(h.DocumentUnsubscribe),
		"sidecarsRetain":           answerOf(h.SidecarsRetain),
		"sidecarsReplace":          doneOf(h.SidecarsReplace),
		"sidecarsOutdated":         readOf(h.SidecarsOutdated),
		"clipboardRead":            answerOf(h.ClipboardRead),
		"linkOpen":                 doneOf(h.LinkOpen),
		"notify":                   doneOf(h.Notify),
		"notificationRemove":       doneOf(h.NotificationRemove),
		"notificationState":        readOf(h.NotificationState),
		"clipboardWriteText":       doneOf(h.ClipboardWriteText),
		"clipboardPersistPNG":      answerOf(h.ClipboardPersistPNG),
		"clipboardReadViewPNG":     answerOf(h.ClipboardReadViewPNG),
		"clipboardPersistViewPNG":  answerOf(h.ClipboardPersistViewPNG),
		"pluginsState":             read(h.PluginsState),
		"debugFiles":               read(h.DebugFiles),
		"debugRecord":              request(h.DebugRecord),
		"debugSave":                answerOf(h.DebugSave),
		"debugSaveText":            answerOf(h.DebugSaveText),
		"filePlace":                answerOf(h.FilePlace),
		"logQuery":                 request(h.LogQuery),
		"debugSaveAll":             readOf(h.DebugSaveAll),
		"debugRead":                request(h.DebugRead),
		"pluginsRun":               request(h.PluginsRun),
		"pluginsUseRegistry":       request(h.PluginsUseRegistry),
		"pluginsStarter":           request(h.PluginsStarter),
		"sidecarSend": func(ctx context.Context, argument json.RawMessage) (any, error) {
			var call struct{ Sidecar, Surface, Body, Cids json.RawMessage }
			if err := json.Unmarshal(argument, &call); err != nil {
				return nil, fmt.Errorf("sidecarSend: %w", err)
			}
			return nil, h.SidecarSend(ctx, call.Sidecar, call.Surface, call.Body, call.Cids)
		},
		"imageCaret": func(ctx context.Context, argument json.RawMessage) (any, error) {
			var call struct {
				Surface, Name       string
				X, Y, Width, Height json.RawMessage
			}
			if err := json.Unmarshal(argument, &call); err != nil {
				return nil, fmt.Errorf("imageCaret: %w", err)
			}
			region, err := json.Marshal(map[string]string{"surface": call.Surface, "name": call.Name})
			if err != nil {
				return nil, fmt.Errorf("imageCaret: %w", err)
			}
			return nil, h.ImageCaret(ctx, region, call.X, call.Y, call.Width, call.Height)
		},
		"imageText": func(ctx context.Context, argument json.RawMessage) (any, error) {
			var call struct {
				Surface, Name string
				Text          json.RawMessage
			}
			if err := json.Unmarshal(argument, &call); err != nil {
				return nil, fmt.Errorf("imageText: %w", err)
			}
			region, err := json.Marshal(map[string]string{"surface": call.Surface, "name": call.Name})
			if err != nil {
				return nil, fmt.Errorf("imageText: %w", err)
			}
			return nil, h.ImageText(ctx, region, call.Text)
		},
	}
}

// The forms of the handlers of the host, each as a HostCall.

func run(handler func()) HostCall {
	return func(context.Context, json.RawMessage) (any, error) {
		handler()
		return nil, nil
	}
}

func read[T any](handler func() (T, error)) HostCall {
	return func(context.Context, json.RawMessage) (any, error) { return handler() }
}

func request[T any](handler func(json.RawMessage) (T, error)) HostCall {
	return func(_ context.Context, argument json.RawMessage) (any, error) { return handler(argument) }
}

func send(handler func(json.RawMessage) error) HostCall {
	return func(_ context.Context, argument json.RawMessage) (any, error) { return nil, handler(argument) }
}

func readOf[T any](handler func(context.Context) (T, error)) HostCall {
	return func(ctx context.Context, _ json.RawMessage) (any, error) { return handler(ctx) }
}

func actOf(handler func(context.Context) error) HostCall {
	return func(ctx context.Context, _ json.RawMessage) (any, error) { return nil, handler(ctx) }
}

func answerOf[T any](handler func(context.Context, json.RawMessage) (T, error)) HostCall {
	return func(ctx context.Context, argument json.RawMessage) (any, error) { return handler(ctx, argument) }
}

func doneOf(handler func(context.Context, json.RawMessage) error) HostCall {
	return func(ctx context.Context, argument json.RawMessage) (any, error) { return nil, handler(ctx, argument) }
}

// Calls runs the host calls of one window. Each handler runs on a goroutine of its own, because SyncSurfaces and PresentSurfaces
// wait for work that runs in steps of the main thread, and its answer arrives in a later step.
type Calls struct {
	table map[string]HostCall
	ctx   context.Context
	post  func(task func())
	// observer receives every call that ended, in the step of its answer.
	observer func(name string, argument any, cids []string, elapsed time.Duration, failure error)
	// transcribe receives every call that ended with its answer, in the step of its answer (diagnostics.transcript).
	transcribe func(name string, argument, value any, failure error)
	mu         sync.Mutex
	// orders holds the calls that wait for the previous call of their order, and an order exists while a call of it runs.
	orders map[string][]func()
	// ended tells that the workbench of the calls ended (End).
	ended atomic.Bool
}

// NewCalls returns the calls of table. post runs a task as a later step of the main thread.
func NewCalls(table map[string]HostCall, post func(task func())) *Calls {
	return &Calls{table: table, ctx: context.Background(), post: post, orders: map[string][]func(){}}
}

// NewHostCalls returns the calls of the host handlers for window.
func NewHostCalls(h *host.Host, window host.Frontend, post func(task func())) *Calls {
	calls := NewCalls(hostCalls(h), post)
	calls.ctx = host.WithFrontend(context.Background(), window)
	return calls
}

// Observe installs the observer of the calls (docs/spec/logging.md#entrances), before the first call.
func (c *Calls) Observe(observer func(name string, argument any, cids []string, elapsed time.Duration, failure error)) {
	c.observer = observer
}

// Transcribe installs the recorder of the diagnostic transcript, which receives each call that ended with its answer.
func (c *Calls) Transcribe(transcribe func(name string, argument, value any, failure error)) {
	c.transcribe = transcribe
}

// End ends the calls with their workbench: a call after it reaches no handler, and a call that still runs gives no answer. A reload
// ends the workbench of the window as it ends a main page, whose calls end with its document, and the host leaves the previous
// workbench, so the answer of such a call is no state of the window (docs/spec/hosts.md#native-views).
func (c *Calls) End() { c.ended.Store(true) }

// Call runs the handler name with argument and gives answer its result in a later step.
func (c *Calls) Call(name string, argument any, answer func(value any, err error)) {
	c.Caused(nil).Call(name, argument, answer)
}

// CallInOrder is Call for a call whose order a specification requires: it starts only after the previous call of order finished.
func (c *Calls) CallInOrder(order, name string, argument any, answer func(value any, err error)) {
	c.Caused(nil).CallInOrder(order, name, argument, answer)
}

// Caused returns the calls that carry out the operation with the correlation identifiers cids (docs/spec/logging.md#operation-chains).
func (c *Calls) Caused(cids []string) CausedCalls { return CausedCalls{calls: c, cids: cids} }

// withContext retains the base frontend values and the source's cancellable lifetime.
func (c *Calls) withContext(ctx context.Context) CausedCalls { return CausedCalls{calls: c, ctx: ctx} }

// CausedCalls are the host calls of one operation.
type CausedCalls struct {
	calls *Calls
	cids  []string
	ctx   context.Context
}

// Call is Calls.Call for a call of the operation.
func (o CausedCalls) Call(name string, argument any, answer func(value any, err error)) {
	o.calls.start(o.ctx, name, argument, o.cids, answer, func() {})
}

// CallInOrder is Calls.CallInOrder for a call of the operation.
func (o CausedCalls) CallInOrder(order, name string, argument any, answer func(value any, err error)) {
	c := o.calls
	begin := func() { c.start(o.ctx, name, argument, o.cids, answer, func() { c.next(order) }) }
	c.mu.Lock()
	waiting, running := c.orders[order]
	if running {
		c.orders[order] = append(waiting, begin)
		c.mu.Unlock()
		return
	}
	c.orders[order] = nil
	c.mu.Unlock()
	begin()
}

// next starts the call that waits for the end of the previous call of order.
func (c *Calls) next(order string) {
	c.mu.Lock()
	waiting := c.orders[order]
	if len(waiting) == 0 {
		delete(c.orders, order)
		c.mu.Unlock()
		return
	}
	c.orders[order] = waiting[1:]
	c.mu.Unlock()
	waiting[0]()
}

// start runs the handler on a goroutine of its own, posts its answer and calls finished.
func (c *Calls) start(ctx context.Context, name string, argument any, cids []string, answer func(value any, err error), finished func()) {
	if ctx == nil {
		ctx = c.ctx
	}
	routine.Go("host-call", func() {
		if c.ended.Load() || ctx.Err() != nil {
			finished()
			return
		}
		started := time.Now()
		value, err := c.invoke(ctx, name, argument, cids)
		elapsed := time.Since(started)
		finished()
		c.post(func() {
			if c.ended.Load() {
				return
			}
			if c.observer != nil {
				c.observer(name, argument, cids, elapsed, err)
			}
			if c.transcribe != nil {
				c.transcribe(name, argument, value, err)
			}
			answer(value, err)
		})
	})
}

// invoke runs the handler name with argument as JSON. The call is an event of the host, as a call through the bound method of a page is.
func (c *Calls) invoke(ctx context.Context, name string, argument any, cids []string) (any, error) {
	call := c.table[name]
	if call == nil {
		return nil, fmt.Errorf("unknown host call: %s", name)
	}
	var raw json.RawMessage
	if argument != nil {
		encoded, err := json.Marshal(argument)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		raw = encoded
	}
	var args []json.RawMessage
	if raw != nil {
		args = []json.RawMessage{raw}
	}
	return host.RecordedCall(ctx, name, args, cids, func() (any, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return call(ctx, raw)
	})
}
