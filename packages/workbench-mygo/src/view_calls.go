package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
)

// The calls of the views of a window (docs/spec/native-surfaces.md#view-surfaces). The host forwards each call request of a view
// as the event view-call, which packages/workbench/view-calls.js answers on the main page. A window of the native workbench has no
// main page, so this file answers it with the same refusals, and every reply goes through the host call viewReply.

// viewCallFailed is the code of a failed view call.
const viewCallFailed = -32000

// viewCallEvent is the value of the event view-call.
type viewCallEvent struct {
	Surface    string          `json:"surface"`
	Plugin     string          `json:"plugin"`
	ID         uint64          `json:"id"`
	Command    string          `json:"command"`
	Params     json.RawMessage `json:"params"`
	Cids       json.RawMessage `json:"cids"`
	Generation uint64          `json:"generation"`
	Cancel     bool            `json:"cancel"`
}

// viewPending is a call of a view that has not replied.
type viewPending struct{ done bool }

// viewState is what the workbench holds for the document of a view.
type viewState struct {
	generation uint64
	revision   uint64
	pending    map[uint64]*viewPending
	// events holds the native events that the view subscribed to. failures holds the sessions that it follows.
	events   map[string]bool
	failures map[string]bool
	// settings tells that the view follows the settings of its plugin, and settingValues is the text of the last values that it holds.
	settings      bool
	settingValues string
	// textSize tells that the view follows its text scale, and scale is the last scale that it received.
	textSize bool
	scale    float64
	// levels tells that the view follows the log levels.
	levels bool
	// data tells that the view follows the project data of its plugin.
	data bool
	// commands holds the commands that the view registered, and requests the answer of each request that it has not replied.
	commands map[string]bool
	requests map[uint64]viewAnswer
	// statuses holds the text of the last value of each core status that the view watches, and observed the end of each watch of a
	// status of a surface.
	statuses map[string]string
	observed map[string]func()
}

// end ends the calls of the page to a view whose document ended.
func (v *viewState) end() {
	for key, stop := range v.observed {
		delete(v.observed, key)
		stop()
	}
	for id, answer := range v.requests {
		delete(v.requests, id)
		answer(nil, errors.New("surface-closed"))
	}
}

// tabReport holds what a view reported of its tab.
type tabReport struct {
	Title, Footer, Directory, Error string
	Modified                        bool
	Keeps                           map[string]bool
	Notice                          *tabNotice
	// noticePolicy is the checked policy of Notice.
	noticePolicy string
}

// tabNotice is the last notification of a view.
type tabNotice struct {
	Text   string          `json:"text"`
	Policy json.RawMessage `json:"policy"`
}

// viewAnswer receives the result of a view call.
type viewAnswer func(result any, err error)

// viewEvents are the native events that a view subscribes to (PLUGIN_NATIVE_EVENTS of view-calls.js).
var viewEvents = map[string]bool{"document-stream": true, "document-state": true, "document-message": true, "image-event": true, "exposure-request": true}

// regionCalls are the host calls of the composition and the regions (REGION_HOST_CALLS of view-calls.js).
var regionCalls = map[string]bool{"compositionDeclare": true, "compositionPlace": true, "documentAttach": true, "documentLoad": true,
	"documentZoom": true, "documentGo": true, "documentDetach": true, "documentSubscribe": true, "documentUnsubscribe": true,
	"documentPost": true, "documentQuery": true, "documentInteractionState": true, "imageAttach": true, "imageFocus": true,
	"imageCaret": true, "imageText": true, "imageDetach": true}

// binaryID is a binary id of the binary store of a view.
var binaryID = regexp.MustCompile(`^[0-9a-f]{32}$`)

// coreRoot is the core root of a view, from which it imports the module of a contribution item.
const coreRoot = "soksak://core"

// errorPlace is the rule of the place of an error line: the record splits a line at its first ": ".
var errorPlace = regexp.MustCompile(`^[^\x00-\x1f\x7f]+$`)

func (s *Shell) view(surface string) *viewState {
	view := s.surfaces.views[surface]
	if view == nil {
		view = &viewState{pending: map[uint64]*viewPending{}, events: map[string]bool{}, failures: map[string]bool{}, commands: map[string]bool{},
			requests: map[uint64]viewAnswer{}, statuses: map[string]string{}, observed: map[string]func(){}}
		s.surfaces.views[surface] = view
	}
	return view
}

func (s *Shell) report(surface string) *tabReport {
	report := s.surfaces.reports[surface]
	if report == nil {
		report = &tabReport{Keeps: map[string]bool{}}
		s.surfaces.reports[surface] = report
	}
	return report
}

// viewCall answers one event view-call.
func (s *Shell) viewCall(data []any) {
	if len(data) != 1 {
		s.fail(fmt.Errorf("view call: the event carries %d values, want one", len(data)))
		return
	}
	call, err := decode[viewCallEvent](data[0])
	if err != nil {
		s.fail(fmt.Errorf("view call: %w", err))
		return
	}
	view := s.view(call.Surface)
	// The first call of a page that started anew can arrive before the end of the page before it.
	if view.generation != 0 && call.Generation > view.generation {
		s.forgetView(call.Surface, view)
		view = s.view(call.Surface)
	}
	if call.Cancel {
		// default: a cancel of a call that has no pending call ends nothing, because that call has already replied.
		if pending := view.pending[call.ID]; pending != nil {
			pending.done = true
			delete(view.pending, call.ID)
			s.viewReply(call, nil, errors.New("cancelled"))
		}
		return
	}
	if view.pending[call.ID] != nil {
		s.viewReply(call, nil, fmt.Errorf("view call %d is already pending", call.ID))
		return
	}
	view.generation = call.Generation
	pending := &viewPending{}
	view.pending[call.ID] = pending
	answer := func(result any, err error) {
		if pending.done {
			return
		}
		pending.done = true
		delete(view.pending, call.ID)
		s.viewReply(call, result, err)
	}
	if err := s.runViewCall(call, view, answer); err != nil {
		answer(nil, err)
	}
}

// viewReply sends the reply of a call.
func (s *Shell) viewReply(call viewCallEvent, result any, err error) {
	reply := map[string]any{"page": s.page, "surface": call.Surface, "generation": call.Generation, "id": call.ID}
	if err != nil {
		reply["error"] = map[string]any{"code": viewCallFailed, "message": err.Error()}
	} else {
		reply["result"] = result
	}
	s.calls.CallInOrder("reply:"+call.Surface, "viewReply", reply, func(_ any, err error) {
		// A reply to a view that ended is refused, and the end of the view is its own event.
		if err != nil && s.surfaces.held[call.Surface] != nil {
			s.options.Report(fmt.Sprintf("view call %s reply: %v", call.Command, err))
		}
	})
}

// viewFields reads the params of a call that takes named fields.
func viewFields[T any](call viewCallEvent) (T, error) {
	var fields T
	if len(call.Params) == 0 || call.Params[0] != '{' {
		return fields, fmt.Errorf("view call %s requires an object", call.Command)
	}
	if err := json.Unmarshal(call.Params, &fields); err != nil {
		return fields, fmt.Errorf("view call %s: %w", call.Command, err)
	}
	return fields, nil
}

// surfaceCall runs a host call of the surface of the view, after the host calls that the view made before it.
func (s *Shell) surfaceCall(call viewCallEvent, name string, fields map[string]any, answer viewAnswer) {
	fields["surface"] = call.Surface
	s.calls.CallInOrder("view:"+call.Surface, name, fields, answer)
}

// region is the named fields of a region call.
type region struct {
	Name    string          `json:"name"`
	Sidecar string          `json:"sidecar"`
	URL     string          `json:"url"`
	Zoom    json.RawMessage `json:"zoom"`
	Action  string          `json:"action"`
	Offset  json.RawMessage `json:"offset"`
	Message json.RawMessage `json:"message"`
	Stream  json.RawMessage `json:"stream"`
	Handle  json.RawMessage `json:"handle"`
	X       float64         `json:"x"`
	Y       float64         `json:"y"`
	Width   float64         `json:"width"`
	Height  float64         `json:"height"`
	Text    json.RawMessage `json:"text"`
}

// runRegion runs a region call. A region of a view is only reached through its composition, with the named fields of the call.
func (s *Shell) runRegion(call viewCallEvent, answer viewAnswer) error {
	fields, err := viewFields[region](call)
	if err != nil {
		return err
	}
	if fields.Name == "" {
		return fmt.Errorf("view call %s requires a non-empty region name", call.Command)
	}
	document := func(name string, extra map[string]any) {
		extra["document"] = fields.Name
		s.surfaceCall(call, name, extra, answer)
	}
	image := func(name string, extra map[string]any) {
		extra["name"] = fields.Name
		s.surfaceCall(call, name, extra, answer)
	}
	switch call.Command {
	case "document.attach":
		s.attachDocument(call, fields.Name, answer)
	case "document.load":
		document("documentLoad", map[string]any{"url": fields.URL})
	case "document.zoom":
		document("documentZoom", map[string]any{"zoom": fields.Zoom})
	case "document.go":
		extra := map[string]any{"action": fields.Action}
		if len(fields.Offset) > 0 {
			extra["offset"] = fields.Offset
		}
		document("documentGo", extra)
	case "document.post":
		document("documentPost", map[string]any{"message": fields.Message})
	case "document.subscribe":
		extra := map[string]any{"document": fields.Name, "stream": fields.Stream}
		s.surfaceCall(call, "documentSubscribe", extra, func(value any, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			reply, err := decode[struct {
				Handle *uint64 `json:"handle"`
			}](value)
			if err == nil && reply.Handle == nil {
				err = fmt.Errorf("document.subscribe %s: the host reply has no handle", fields.Name)
			}
			if err != nil {
				answer(nil, err)
				return
			}
			answer(*reply.Handle, nil)
		})
	case "document.unsubscribe":
		document("documentUnsubscribe", map[string]any{"handle": fields.Handle})
	case "document.detach":
		delete(s.surfaces.documents[call.Surface], fields.Name)
		document("documentDetach", map[string]any{})
	case "image.attach":
		image("imageAttach", map[string]any{"sidecar": fields.Sidecar})
	case "image.focus":
		image("imageFocus", map[string]any{})
	case "image.caret":
		image("imageCaret", map[string]any{"x": fields.X, "y": fields.Y, "width": fields.Width, "height": fields.Height})
	case "image.text":
		image("imageText", map[string]any{"text": fields.Text})
	case "image.detach":
		s.surfaces.detaching[call.Surface] = true
		detached := answer
		answer = func(value any, err error) {
			if err == nil {
				delete(s.surfaces.detaching, call.Surface)
			}
			detached(value, err)
		}
		image("imageDetach", map[string]any{})
	}
	return nil
}

// runViewCall runs the call and gives answer its result. A returned error is a refusal of the call.
func (s *Shell) runViewCall(call viewCallEvent, view *viewState, answer viewAnswer) error {
	unit := s.units[call.Plugin]
	if unit == nil {
		return fmt.Errorf("view call %s: plugin %s is not installed", call.Command, call.Plugin)
	}
	done := func() { answer(nil, nil) }
	text := func() (string, error) {
		var value string
		if err := json.Unmarshal(call.Params, &value); err != nil {
			return "", fmt.Errorf("view call %s requires a string", call.Command)
		}
		return value, nil
	}
	if strings.HasPrefix(call.Command, "document.") || strings.HasPrefix(call.Command, "image.") {
		return s.runRegion(call, answer)
	}
	switch call.Command {
	case "composition.declaration":
		answer(map[string]any{"kind": unit.Declaration.Kind, "regions": nonNil(unit.Declaration.Regions), "overlays": nonNil(unit.Declaration.Overlays)}, nil)
	case "composition.place":
		fields, err := viewFields[struct {
			Regions  []json.RawMessage `json:"regions"`
			Overlays []json.RawMessage `json:"overlays"`
		}](call)
		if err != nil {
			return err
		}
		if fields.Regions == nil || fields.Overlays == nil {
			return fmt.Errorf("view call %s requires the arrays regions and overlays", call.Command)
		}
		view.revision++
		s.surfaceCall(call, "compositionPlace", map[string]any{"revision": view.revision, "regions": fields.Regions, "overlays": fields.Overlays}, answer)
	case "composition.report":
		line, err := text()
		if err != nil {
			return err
		}
		s.options.Report(line)
		done()
	case "runtime.native.call":
		return s.runNativeCall(call, view, unit, answer)
	case "runtime.native.on":
		fields, err := viewFields[struct {
			Name string `json:"name"`
		}](call)
		if err != nil {
			return err
		}
		if !viewEvents[fields.Name] {
			return fmt.Errorf("native event %s is not served: the view bridge is internal", fields.Name)
		}
		view.events[fields.Name] = true
		done()
	case "runtime.sidecar.send":
		fields, err := viewFields[struct {
			Sidecar string          `json:"sidecar"`
			ID      string          `json:"id"`
			Body    json.RawMessage `json:"body"`
			Cids    json.RawMessage `json:"cids"`
		}](call)
		if err != nil {
			return err
		}
		if !declares(unit.Sidecars, fields.Sidecar) {
			return fmt.Errorf("surface %s cannot send to sidecar %s", call.Surface, fields.Sidecar)
		}
		if fields.ID != call.Surface {
			return fmt.Errorf("surface %s cannot send to sidecar surface %s", call.Surface, fields.ID)
		}
		request := map[string]any{"sidecar": fields.Sidecar, "surface": call.Surface, "body": fields.Body}
		if len(fields.Cids) > 0 {
			request["cids"] = fields.Cids
		}
		s.calls.CallInOrder("sidecar:"+fields.Sidecar, "sidecarSend", request, answer)
	case "runtime.sidecar.on":
		fields, err := viewFields[struct {
			ID      string `json:"id"`
			Sidecar string `json:"sidecar"`
		}](call)
		if err != nil {
			return err
		}
		if fields.ID == "" {
			return fmt.Errorf("view call %s requires a non-empty id", call.Command)
		}
		if !declares(unit.Sidecars, fields.Sidecar) {
			return fmt.Errorf("view call %s: %s declares no sidecar %s", call.Command, call.Plugin, fields.Sidecar)
		}
		s.surfaceCall(call, "viewSidecarRoute", map[string]any{"generation": view.generation, "sidecar": fields.Sidecar, "id": fields.ID, "on": true},
			func(_ any, err error) { answer(nil, err) })
	case "runtime.sidecar.onFailure":
		fields, err := viewFields[struct {
			ID string `json:"id"`
		}](call)
		if err != nil {
			return err
		}
		if fields.ID == "" {
			return fmt.Errorf("view call %s requires a non-empty id", call.Command)
		}
		view.failures[fields.ID] = true
		done()
	case "runtime.settings.read":
		answer(s.viewSettings(unit), nil)
	case "runtime.settings.on":
		view.settings, view.settingValues = true, jsonText(s.viewSettings(unit))
		done()
	case "runtime.data.get", "runtime.data.set", "runtime.data.on":
		return s.runDataCall(call, unit, view, answer)
	case "runtime.textSize.read":
		size, err := s.viewTextSize(call.Surface, view)
		if err != nil {
			return err
		}
		view.scale = size
		answer(size, nil)
	case "runtime.textSize.on":
		size, err := s.viewTextSize(call.Surface, view)
		if err != nil {
			return err
		}
		view.scale, view.textSize = size, true
		done()
	case "runtime.log.levels.on":
		view.levels = true
		done()
	case "tab.state.read":
		if unit.Unload == nil || s.tabs == nil || s.tabs.states == nil {
			return fmt.Errorf("view call %s: the tab state is not declared", call.Command)
		}
		value, err := readTabState(call.Surface, unit, s.tabs.states)
		if err != nil {
			return err
		}
		answer(value, nil)
	case "tab.state.write":
		if unit.Unload == nil || s.tabs == nil || s.tabs.states == nil {
			return fmt.Errorf("view call %s: the tab state is not declared", call.Command)
		}
		if len(call.Params) > unit.Unload.MaxBytes {
			return fmt.Errorf("tab %s state of %d bytes exceeds %d", call.Surface, len(call.Params), unit.Unload.MaxBytes)
		}
		state, err := json.Marshal(map[string]json.RawMessage{"format": unit.Unload.Format, "value": call.Params})
		if err != nil {
			return err
		}
		s.tabs.states.Write(call.Surface, state)
		done()
	case "tab.focus":
		if err := s.keyboard.SetViewFocus(call.Surface, call.Params); err != nil {
			return err
		}
		done()
	case "tab.notify":
		notice, err := viewFields[tabNotice](call)
		if err != nil {
			return err
		}
		if err := s.reportNotice(call.Surface, notice); err != nil {
			return err
		}
		done()
	case "runtime.links.open":
		url, err := text()
		if err != nil {
			return err
		}
		if url == "" {
			return fmt.Errorf("view call %s requires a non-empty URL", call.Command)
		}
		s.calls.Call("linkOpen", map[string]string{"url": url}, func(_ any, err error) { answer(nil, err) })
	case "runtime.clipboard.read":
		return s.readClipboard(call, text, answer)
	case "runtime.clipboard.writeText":
		value, err := text()
		if err != nil {
			return err
		}
		s.calls.Call("clipboardWriteText", value, func(_ any, err error) { answer(nil, err) })
	case "runtime.clipboard.persistPNG":
		fields, err := viewFields[struct {
			Binary string `json:"binary"`
		}](call)
		if err != nil {
			return err
		}
		if !binaryID.MatchString(fields.Binary) {
			return fmt.Errorf("view call %s requires binary, the id of an upload to the binary path of the view", call.Command)
		}
		s.surfaceCall(call, "clipboardPersistViewPNG", map[string]any{"binary": fields.Binary}, func(value any, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			persisted, err := decode[struct {
				Path string `json:"path"`
			}](value)
			if err == nil && persisted.Path == "" {
				err = fmt.Errorf("view call %s: the clipboard PNG persistence reply of the host is invalid", call.Command)
			}
			if err != nil {
				answer(nil, err)
				return
			}
			answer(map[string]string{"path": persisted.Path, "shellQuotedPath": "'" + strings.ReplaceAll(persisted.Path, "'", `'\''`) + "'"}, nil)
		})
	case "runtime.command.register":
		fields, err := viewFields[struct {
			Name string `json:"name"`
		}](call)
		if err != nil {
			return err
		}
		if fields.Name == "" {
			return fmt.Errorf("view call %s requires a non-empty name", call.Command)
		}
		if view.commands[fields.Name] {
			return fmt.Errorf("command %s is already registered", fields.Name)
		}
		// The registry checks the declaration and the owner, then the host records the registration.
		if err := s.registry.Registered(SurfaceRegistered{Surface: call.Surface, Kind: "command", Name: fields.Name}); err != nil {
			return err
		}
		view.commands[fields.Name] = true
		s.surfaceCall(call, "exposureRegister", map[string]any{"kind": "command", "name": fields.Name}, func(_ any, err error) {
			if err != nil {
				delete(view.commands, fields.Name)
			}
			answer(nil, err)
		})
	case "runtime.command.run":
		fields, err := viewFields[struct {
			Name    string          `json:"name"`
			Surface string          `json:"surface"`
			Params  json.RawMessage `json:"params"`
		}](call)
		if err != nil {
			return err
		}
		if owner, _, _ := strings.Cut(fields.Name, "."); owner != call.Plugin {
			return fmt.Errorf("view call %s %s is not a command of %s", call.Command, fields.Name, call.Plugin)
		}
		if held := s.surfaces.held[fields.Surface]; held == nil || held.tab.Plugin != call.Plugin {
			return fmt.Errorf("view call %s surface %s is not a surface of %s", call.Command, fields.Surface, call.Plugin)
		}
		s.registry.RunOwned(fields.Name, fields.Params, call.Cids, call.Plugin, fields.Surface, "", answer)
	case "runtime.status.watch", "runtime.status.unwatch":
		fields, err := viewFields[struct {
			Name    string  `json:"name"`
			Surface *string `json:"surface"`
		}](call)
		if err != nil {
			return err
		}
		if fields.Name == "" {
			return fmt.Errorf("view call %s requires a non-empty name", call.Command)
		}
		if owner := ownerOf(fields.Name); owner != "core" && owner != call.Plugin {
			return fmt.Errorf("view call %s %s is neither a core status nor a status of %s", call.Command, fields.Name, call.Plugin)
		}
		if fields.Surface != nil || registeredBySurface(fields.Name) {
			return s.observeForView(call, view, fields.Name, fields.Surface, answer)
		}
		if call.Command == "runtime.status.unwatch" {
			delete(view.statuses, fields.Name)
			done()
			return nil
		}
		if !s.options.Declared.Statuses[fields.Name] {
			return fmt.Errorf("view call %s %s is not a declared status", call.Command, fields.Name)
		}
		view.statuses[fields.Name] = ""
		done()
		s.pushStatuses()
	case "runtime.contributions":
		fields, err := viewFields[struct {
			Point string `json:"point"`
		}](call)
		if err != nil {
			return err
		}
		items, err := s.contributions.Of(call.Plugin, fields.Point)
		if err != nil {
			return err
		}
		answer(viewContributions(items), nil)
	case "runtime.contributions.fail":
		fields, err := viewFields[struct {
			Point  string `json:"point"`
			Plugin string `json:"plugin"`
			Index  int    `json:"index"`
			Reason string `json:"reason"`
		}](call)
		if err != nil {
			return err
		}
		if fields.Reason == "" {
			return fmt.Errorf("view call %s requires a non-empty reason", call.Command)
		}
		items, err := s.contributions.Of(call.Plugin, fields.Point)
		if err != nil {
			return err
		}
		for _, item := range items {
			if item.Plugin == fields.Plugin && item.Index == fields.Index {
				item.Fail(errors.New(fields.Reason))
				done()
				return nil
			}
		}
		return fmt.Errorf("view call %s: %s has no connected item %d of %s", call.Command, fields.Point, fields.Index, fields.Plugin)
	case "surface.menu":
		fields, err := viewFields[struct {
			X *float64 `json:"x"`
			Y *float64 `json:"y"`
		}](call)
		if err != nil {
			return err
		}
		if fields.X == nil || fields.Y == nil {
			return fmt.Errorf("view call %s requires x and y as finite numbers", call.Command)
		}
		held := s.surfaces.held[call.Surface]
		if !unit.Menu || held == nil {
			answer(false, nil)
			return nil
		}
		params, err := json.Marshal(map[string]any{"surface": call.Surface, "x": held.box.X + *fields.X, "y": held.box.Y + *fields.Y})
		if err != nil {
			return err
		}
		s.registry.RunLater("core.surface.menu", params, func(_ any, err error) { answer(true, err) })
	case "runtime.shortcuts.read":
		rows := []map[string]string{}
		for _, row := range s.options.Declared.Shortcuts {
			if row.Owner == "workbench" || row.Owner == "view" {
				rows = append(rows, map[string]string{"key": row.Key, "owner": row.Owner, "command": row.Command})
			}
		}
		answer(rows, nil)
	case "runtime.error":
		fields, err := viewFields[struct {
			Where string `json:"where"`
			Text  string `json:"text"`
		}](call)
		if err != nil {
			return err
		}
		if !errorPlace.MatchString(fields.Where) || strings.Contains(fields.Where, ": ") {
			return fmt.Errorf(`view call %s requires a non-empty where without a control character or ": "`, call.Command)
		}
		if fields.Text == "" {
			return fmt.Errorf("view call %s requires a non-empty text", call.Command)
		}
		s.options.Report(fmt.Sprintf("surface %s %s: %s", call.Surface, fields.Where, fields.Text))
		done()
	case "tab.title", "tab.footer", "tab.directory", "tab.error":
		value, err := text()
		if err != nil {
			return err
		}
		report := s.report(call.Surface)
		if call.Command == "tab.title" && s.tabs != nil {
			s.tabs.states.CacheLabel(call.Surface, call.Plugin, &value)
		}
		field := map[string]*string{"tab.title": &report.Title, "tab.footer": &report.Footer, "tab.directory": &report.Directory,
			"tab.error": &report.Error}[call.Command]
		if *field != value {
			*field = value
			s.options.Invalidate()
		}
		done()
	case "tab.modified":
		var modified bool
		if err := json.Unmarshal(call.Params, &modified); err != nil {
			return fmt.Errorf("view call %s requires a boolean", call.Command)
		}
		if report := s.report(call.Surface); report.Modified != modified {
			report.Modified = modified
			s.options.Invalidate()
		}
		done()
	case "tab.keep":
		fields, err := viewFields[struct {
			Reason string `json:"reason"`
			On     bool   `json:"on"`
		}](call)
		if err != nil {
			return err
		}
		if fields.On {
			s.report(call.Surface).Keeps[fields.Reason] = true
		} else {
			delete(s.report(call.Surface).Keeps, fields.Reason)
		}
		done()
	default:
		return s.runCommandCall(call, answer)
	}
	return nil
}

// runCommandCall runs the command that names a call: a core command, or a command that the view registered. Any other name is
// refused as runCommandCall of packages/workbench/command-route.js refuses it.
func (s *Shell) runCommandCall(call viewCallEvent, answer viewAnswer) error {
	owner, _, dotted := strings.Cut(call.Command, ".")
	switch {
	case !dotted:
		return fmt.Errorf("view call %s names no owner", call.Command)
	case owner == "core":
		s.registry.RunLater(call.Command, call.Params, answer)
		return nil
	case owner == call.Plugin:
		s.registry.RunOwned(call.Command, call.Params, call.Cids, call.Plugin, "", call.Surface, answer)
		return nil
	case owner == "tab" || owner == "runtime":
		return fmt.Errorf("view call %s is not served", call.Command)
	}
	return fmt.Errorf("command %s belongs to %s, not %s", call.Command, owner, call.Plugin)
}

// runViewCommand sends a command that the view of surface registered to that view. The reply arrives as the event view-reply, and
// the post may instead settle the command, for a view whose source was replaced. A view that does not reply within the declared
// limit of the command ends it.
func (s *Shell) runViewCommand(surface string, view *viewState, name string, params, cids json.RawMessage, answer viewAnswer) {
	s.surfaces.command++
	id := s.surfaces.command
	limit := s.registry.CommandTimeout(name)
	var timer *time.Timer
	ended := false
	settle := func(result any, err error) {
		if ended {
			return
		}
		ended = true
		timer.Stop()
		delete(view.requests, id)
		answer(result, err)
	}
	timer = time.AfterFunc(limit, func() {
		s.options.Post(func() { settle(nil, fmt.Errorf("command %s did not reply within %dms", name, limit.Milliseconds())) })
	})
	view.requests[id] = settle
	request := map[string]any{"surface": surface, "generation": view.generation, "id": id, "command": name, "params": rawOrNull(params)}
	if len(cids) > 0 {
		request["cids"] = cids
	}
	s.calls.CallInOrder("view:"+surface, "viewRequest", request, func(value any, err error) {
		if err != nil {
			settle(nil, err)
			return
		}
		disposition, err := decode[*struct {
			Cancelled        bool     `json:"cancelled"`
			SourceGeneration *float64 `json:"sourceGeneration"`
		}](value)
		switch {
		case err == nil && disposition == nil:
		case err == nil && disposition.Cancelled && disposition.SourceGeneration != nil && *disposition.SourceGeneration >= 1:
			settle(value, nil)
		default:
			settle(nil, errors.New("native command post returned an invalid disposition"))
		}
	})
}

// viewReplied receives the reply of a view to a command, the event view-reply.
func (s *Shell) viewReplied(data []any) {
	if len(data) != 1 {
		return
	}
	reply, err := decode[struct {
		Surface string          `json:"surface"`
		ID      uint64          `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   *Refusal        `json:"error"`
	}](data[0])
	if err != nil {
		s.fail(fmt.Errorf("view reply: %w", err))
		return
	}
	view := s.surfaces.views[reply.Surface]
	if view == nil || view.requests[reply.ID] == nil {
		return
	}
	if reply.Error != nil {
		view.requests[reply.ID](nil, reply.Error)
		return
	}
	view.requests[reply.ID](reply.Result, nil)
}

// viewExposure answers a request that the host forwarded to a surface, and tells whether the request is one. A command that the view
// registered runs in the view, and any other request goes to the view that subscribed to the requests.
func (s *Shell) viewExposure(data []any) bool {
	if len(data) != 1 {
		return false
	}
	request, err := decode[struct {
		ID      uint64 `json:"id"`
		Method  string `json:"method"`
		Surface string `json:"surface"`
		Params  struct {
			Name   string          `json:"name"`
			Params json.RawMessage `json:"params"`
			Cids   json.RawMessage `json:"cids"`
		} `json:"params"`
	}](data[0])
	if err != nil || request.Surface == "" {
		return false
	}
	answer := func(result any, err error) { s.requests.ReplyFor(request.Surface, request.ID, result, err) }
	if view := s.surfaces.views[request.Surface]; view != nil && request.Method == "command.run" && view.commands[request.Params.Name] {
		s.runViewCommand(request.Surface, view, request.Params.Name, request.Params.Params, request.Params.Cids, answer)
		return true
	}
	if !s.viewEvent("exposure-request", data) {
		answer(nil, Refuse(Gone, "surface %s does not answer %s", request.Surface, request.Method))
	}
	return true
}

// viewSettings returns the values of the settings of a plugin.
func (s *Shell) viewSettings(unit *installedUnit) map[string]any {
	values := make(map[string]any, len(unit.Settings))
	for _, local := range unit.Settings {
		values[local] = s.settings.Value(unit.ID + "." + local)
	}
	return values
}

// surfaceTextSize returns the text scale of the surface: the frame factor multiplied by the factor of its card, and false for a tab of a
// space off the screen, which has no card.
func (s *Shell) surfaceTextSize(surface string) (float64, bool) {
	if held := s.surfaces.held[surface]; held != nil && held.section != nil {
		return s.text.Frame(), true
	}
	card := s.cardOfTab(surface)
	if card == "" {
		return 0, false
	}
	return s.text.Effective(card), true
}

// viewTextSize returns the text scale that view reads: a view of a space off the screen keeps the scale it last had.
func (s *Shell) viewTextSize(surface string, view *viewState) (float64, error) {
	if size, shown := s.surfaceTextSize(surface); shown {
		return size, nil
	}
	if view.scale == 0 {
		return 0, fmt.Errorf("surface %s is not in the layout", surface)
	}
	return view.scale, nil
}

// readTabState returns the value of the state of the tab: null without one, and a state of another format is refused.
func readTabState(tab string, unit *installedUnit, states *TabStates) (any, error) {
	entry, _ := states.Entry(tab) // silent: a tab without an entry reads null, as a tab without a state.
	if len(entry.State) == 0 {
		return nil, nil
	}
	var stored struct {
		Format json.RawMessage `json:"format"`
		Value  json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(entry.State, &stored); err != nil {
		return nil, fmt.Errorf("tab %s state: %w", tab, err)
	}
	if string(stored.Format) != string(unit.Unload.Format) {
		return nil, fmt.Errorf("tab %s state format %s is not %s", tab, stored.Format, unit.Unload.Format)
	}
	return stored.Value, nil
}

// readClipboard answers the call runtime.clipboard.read. A PNG travels through the binary store of the view.
func (s *Shell) readClipboard(call viewCallEvent, text func() (string, error), answer viewAnswer) error {
	kind, err := text()
	if err != nil {
		return err
	}
	switch kind {
	case "png":
		s.surfaceCall(call, "clipboardReadViewPNG", map[string]any{"userInitiated": true}, func(value any, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			png, err := decode[struct {
				Present bool   `json:"present"`
				Type    string `json:"type"`
				Binary  string `json:"binary"`
			}](value)
			switch {
			case err != nil:
				answer(nil, err)
			case png.Type == "png" && !png.Present:
				answer(nil, nil)
			case png.Type != "png" || !binaryID.MatchString(png.Binary):
				answer(nil, fmt.Errorf("view call %s png: the clipboard png reply of the host is invalid", call.Command))
			default:
				answer(png, nil)
			}
		})
	case "text", "fileURLs":
		s.calls.Call("clipboardRead", map[string]any{"type": kind, "userInitiated": true}, func(value any, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			read, err := decode[struct {
				Present bool            `json:"present"`
				Type    string          `json:"type"`
				Text    json.RawMessage `json:"text"`
				URLs    json.RawMessage `json:"urls"`
			}](value)
			switch {
			case err != nil:
				answer(nil, err)
			case read.Type != kind:
				answer(nil, fmt.Errorf("clipboard response type mismatch for %s", kind))
			case !read.Present:
				answer(nil, nil)
			case kind == "text":
				answer(read.Text, nil)
			default:
				answer(read.URLs, nil)
			}
		})
	default:
		return fmt.Errorf("view call %s %s is not served", call.Command, kind)
	}
	return nil
}

// viewContributions returns the connected items as a view reads them: the module of an item comes from the core root.
func viewContributions(items []ConnectedItem) []map[string]any {
	listed := make([]map[string]any, len(items))
	for i, item := range items {
		listed[i] = map[string]any{"plugin": item.Plugin, "index": item.Index, "item": item.Item, "module": coreRoot + item.Module}
	}
	return listed
}

// observeForView starts or ends the watch of a view on a status that surfaces hold. An unwatch ends only a watch of this view, so its
// surface is not checked: the surface can close before the view unwatches it. The status event carries the surface only when the
// watch names one.
func (s *Shell) observeForView(call viewCallEvent, view *viewState, name string, surface *string, answer viewAnswer) error {
	key := name
	if surface != nil {
		key = observeKey(name, *surface)
	}
	if call.Command == "runtime.status.unwatch" {
		if stop := view.observed[key]; stop != nil {
			delete(view.observed, key)
			stop()
		}
		answer(nil, nil)
		return nil
	}
	if surface != nil && (*surface == "" || s.surfacePlugin(*surface) != call.Plugin) {
		return fmt.Errorf("view call %s surface %s is not a surface of %s", call.Command, *surface, call.Plugin)
	}
	if !s.registry.isDeclared("status", name) {
		return fmt.Errorf("view call %s %s is not a declared status", call.Command, name)
	}
	if view.observed[key] == nil {
		view.observed[key] = s.registry.Observe(name, surface, surface != nil, func(value any) {
			data := map[string]any{"name": name, "value": value}
			if surface != nil {
				data["surface"] = *surface
			}
			s.pushView(call.Surface, view, "status", data)
		})
	}
	answer(nil, nil)
	return nil
}

// pushStatuses sends each watched status of a view and of the endpoint whose value changed.
func (s *Shell) pushStatuses() {
	if err := s.registry.Changed(); err != nil {
		s.fail(err)
	}
	for surface, view := range s.surfaces.views {
		for name, last := range view.statuses {
			value, err := s.registry.Read(name)
			if err != nil {
				continue // A status that cannot be read now has no new value.
			}
			text, err := json.Marshal(value)
			if err != nil || string(text) == last {
				continue
			}
			view.statuses[name] = string(text)
			s.pushView(surface, view, "status", map[string]any{"name": name, "value": value})
		}
	}
}

// runNativeCall runs the call runtime.native.call: the registrations of the view and the one host call that reaches a plugin.
func (s *Shell) runNativeCall(call viewCallEvent, view *viewState, unit *installedUnit, answer viewAnswer) error {
	fields, err := viewFields[struct {
		Name    string          `json:"name"`
		Payload json.RawMessage `json:"payload"`
	}](call)
	if err != nil {
		return err
	}
	if fields.Name == "" {
		return fmt.Errorf("view call %s requires a non-empty name", call.Command)
	}
	if regionCalls[fields.Name] {
		return fmt.Errorf("view call %s %s is not served: a view operates its regions through its composition", call.Command, fields.Name)
	}
	var payload map[string]any
	if err := json.Unmarshal(fields.Payload, &payload); err != nil {
		return fmt.Errorf("view call %s %s: %w", call.Command, fields.Name, err)
	}
	switch fields.Name {
	case "registered":
		kind, _ := payload["kind"].(string) // silent: an absent kind is refused below as an empty one.
		name, _ := payload["name"].(string) // silent: as above.
		if kind == "" || name == "" {
			return fmt.Errorf("view call %s requires a non-empty kind and name", fields.Name)
		}
		if kind == "command" && !surfaceNames[name] {
			return fmt.Errorf("view call %s: command %s is registered through runtime.command.register", fields.Name, name)
		}
		// The registry applies the registration, then the host records it, as the page does.
		if err := s.registry.Registered(SurfaceRegistered{Surface: call.Surface, Kind: kind, Name: name}); err != nil {
			return err
		}
		s.surfaceCall(call, "exposureRegister", map[string]any{"kind": kind, "name": name}, func(_ any, err error) { answer(nil, err) })
	case "changed":
		change, err := changeOf(call.Surface, fields.Payload)
		if err != nil {
			return err
		}
		s.registry.Deliver(change)
		answer(nil, nil)
	case "exposureReply":
		s.surfaceCall(call, "exposureReply", payload, func(_ any, err error) { answer(nil, err) })
	default:
		return fmt.Errorf("host call %s is not served to plugins", fields.Name)
	}
	return nil
}

// changeOf reads the value of a watched status of the view of surface (docs/spec/exposure.md#relay).
func changeOf(surface string, payload json.RawMessage) (SurfaceChange, error) {
	refused := errors.New("view call changed requires a non-empty name, a value and a positive integer version")
	var fields struct {
		Name    string          `json:"name"`
		Value   json.RawMessage `json:"value"`
		Version *float64        `json:"version"`
	}
	if err := json.Unmarshal(payload, &fields); err != nil {
		return SurfaceChange{}, fmt.Errorf("%w: %v", refused, err)
	}
	// The largest safe integer of the page, which a version does not pass.
	const maxVersion = 1<<53 - 1
	if fields.Name == "" || fields.Value == nil || fields.Version == nil || *fields.Version < 1 || *fields.Version > maxVersion ||
		*fields.Version != math.Trunc(*fields.Version) {
		return SurfaceChange{}, refused
	}
	return SurfaceChange{Surface: surface, Name: fields.Name, Value: fields.Value, Version: int64(*fields.Version)}, nil
}

// nonNil returns a list that encodes as an array when it is empty.
func nonNil[T any](list []T) []T {
	if list == nil {
		return []T{}
	}
	return list
}

func declares(list []string, name string) bool {
	for _, item := range list {
		if item == name {
			return true
		}
	}
	return false
}

// surfaceEvent is the part of a surface event that decides who receives it.
type surfaceEvent struct {
	Surface string `json:"surface"`
}

// viewEvent pushes the event to the view of its surface when the view subscribed to it, and tells whether it did.
func (s *Shell) viewEvent(name string, data []any) bool {
	if len(data) != 1 {
		return false
	}
	event, err := decode[surfaceEvent](data[0])
	if err != nil {
		s.fail(fmt.Errorf("event %s: %w", name, err))
		return false
	}
	view := s.surfaces.views[event.Surface]
	if view == nil || !view.events[name] {
		return false
	}
	s.pushView(event.Surface, view, name, data[0])
	return true
}

// pushView sends one event to a view.
func (s *Shell) pushView(surface string, view *viewState, name string, data any) {
	s.calls.CallInOrder("event:"+surface, "viewEvent", map[string]any{"surface": surface, "generation": view.generation, "event": name, "data": data},
		func(_ any, err error) {
			if err != nil && s.surfaces.held[surface] != nil {
				s.options.Report(fmt.Sprintf("view event %s: %v", name, err))
			}
		})
}

// viewEnded forgets the document of a view whose process ended: its calls and its subscriptions ended with it.
func (s *Shell) viewEnded(data []any) {
	if len(data) != 1 {
		return
	}
	event, err := decode[struct {
		Surface    string `json:"surface"`
		Generation uint64 `json:"generation"`
	}](data[0])
	if err != nil {
		s.fail(fmt.Errorf("view process ended: %w", err))
		return
	}
	view := s.surfaces.views[event.Surface]
	if view == nil || view.generation != event.Generation {
		return
	}
	s.forgetView(event.Surface, view)
}

// forgetView ends what the page of a view held.
func (s *Shell) forgetView(surface string, view *viewState) {
	view.end()
	delete(s.surfaces.views, surface)
	s.keyboard.ForgetView(surface)
	delete(s.surfaces.documents, surface)
}

// viewStopped shows the reason of a view that stopped its restarts as the error of its surface.
func (s *Shell) viewStopped(data []any) {
	if len(data) != 1 {
		return
	}
	event, err := decode[struct {
		Surface string `json:"surface"`
		Reason  string `json:"reason"`
	}](data[0])
	if err != nil {
		s.fail(fmt.Errorf("view stopped: %w", err))
		return
	}
	s.surfaces.failed[event.Surface] = event.Reason
	s.options.Invalidate()
}

// sidecarFailed gives a failure of a sidecar session to the view that follows it, or shows it.
func (s *Shell) sidecarFailed(data []any) {
	if len(data) != 1 {
		return
	}
	failure, err := decode[struct {
		Sidecar string `json:"sidecar"`
		Surface string `json:"surface"`
		Reason  string `json:"reason"`
	}](data[0])
	if err != nil {
		s.fail(fmt.Errorf("sidecar failure: %w", err))
		return
	}
	if view := s.surfaces.views[failure.Surface]; view != nil && view.failures[failure.Surface] {
		s.pushView(failure.Surface, view, "sidecar.failure", map[string]any{"id": failure.Surface, "reason": failure.Reason})
		return
	}
	s.fail(fmt.Errorf("sidecar %s failed for surface %s: %s", failure.Sidecar, failure.Surface, failure.Reason))
}

// surfacePressed focuses the card of a surface that a pointer pressed.
func (s *Shell) surfacePressed(data []any) {
	if len(data) != 1 || s.plane == nil {
		return
	}
	surface, err := decode[string](data[0])
	if err != nil {
		s.fail(fmt.Errorf("surface pressed: %w", err))
		return
	}
	s.pressSurface(surface)
}
