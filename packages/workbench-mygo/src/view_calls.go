package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
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
	settings bool
	// textSize and levels tell that the view follows the text scale of its surface and the log levels.
	textSize bool
	levels   bool
	// commands holds the commands that the view registered, and watches the text of the last value of each status it follows.
	commands map[string]bool
	watches  map[string]string
}

// tabReport holds what a view reported of its tab.
type tabReport struct {
	Title, Footer, Directory, Error string
	Modified                        bool
	Keeps                           map[string]bool
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

// errorPlace is the rule of the place of an error line: the record splits a line at its first ": ".
var errorPlace = regexp.MustCompile(`^[^\x00-\x1f\x7f]+$`)

func (s *Shell) view(surface string) *viewState {
	view := s.surfaces.views[surface]
	if view == nil {
		view = &viewState{pending: map[uint64]*viewPending{}, events: map[string]bool{}, failures: map[string]bool{},
			commands: map[string]bool{}, watches: map[string]string{}}
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
		document("documentAttach", map[string]any{})
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
		image("imageDetach", map[string]any{})
	}
	return nil
}

// runViewCall runs the call and gives answer its result. A returned error is a refusal of the call.
func (s *Shell) runViewCall(call viewCallEvent, view *viewState, answer viewAnswer) error {
	unit := s.plugins[call.Plugin]
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
		answer(unit.Settings, nil)
	case "runtime.settings.on":
		view.settings = true
		done()
	case "runtime.textSize.read":
		factor, err := s.surfaceTextSize(call.Surface)
		if err != nil {
			return err
		}
		answer(factor, nil)
	case "runtime.textSize.on":
		view.textSize = true
		done()
	case "runtime.log.levels.on":
		view.levels = true
		done()
	case "runtime.status.watch", "runtime.status.unwatch":
		return s.runStatusWatch(call, view, answer)
	case "runtime.command.register":
		fields, err := viewFields[struct {
			Name string `json:"name"`
		}](call)
		if err != nil {
			return err
		}
		if !unit.declaresCommand(fields.Name) {
			return fmt.Errorf("view call %s: %q is not a declared command of plugin %s", call.Command, fields.Name, unit.ID)
		}
		view.commands[fields.Name] = true
		done()
	case "tab.focus":
		var focus *struct {
			Name  string `json:"name"`
			Index *int   `json:"index"`
		}
		if err := json.Unmarshal(call.Params, &focus); err != nil {
			return fmt.Errorf("view call %s: %w", call.Command, err)
		}
		if focus != nil && (focus.Name == "" || focus.Index == nil || *focus.Index < 0) {
			return fmt.Errorf("view call %s requires {name, index} or null", call.Command)
		}
		done()
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
		switch call.Command {
		case "tab.title":
			report.Title = value
		case "tab.footer":
			report.Footer = value
		case "tab.directory":
			report.Directory = value
		case "tab.error":
			report.Error = value
		}
		s.options.Invalidate()
		done()
	case "tab.modified":
		var modified bool
		if err := json.Unmarshal(call.Params, &modified); err != nil {
			return fmt.Errorf("view call %s requires a boolean", call.Command)
		}
		s.report(call.Surface).Modified = modified
		s.options.Invalidate()
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
		return fmt.Errorf("view call %s is not served", call.Command)
	}
	return nil
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
		s.surfaceCall(call, "exposureRegister", map[string]any{"kind": kind, "name": name}, func(_ any, err error) { answer(nil, err) })
	case "changed":
		s.surfaceCall(call, "exposureChanged", payload, func(_ any, err error) { answer(nil, err) })
	case "exposureReply":
		s.surfaceCall(call, "exposureReply", payload, func(_ any, err error) { answer(nil, err) })
	default:
		return fmt.Errorf("host call %s is not served to plugins", fields.Name)
	}
	return nil
}

// runStatusWatch starts or ends the watch of a status of the workbench. The value follows at once as the event status, as the
// value of each later change does. The status of another surface stands in the document of that surface, and no view of this
// window follows one.
func (s *Shell) runStatusWatch(call viewCallEvent, view *viewState, answer viewAnswer) error {
	fields, err := viewFields[struct {
		Name    string `json:"name"`
		Surface string `json:"surface"`
	}](call)
	if err != nil {
		return err
	}
	if fields.Name == "" {
		return fmt.Errorf("view call %s requires a non-empty name", call.Command)
	}
	if fields.Surface != "" {
		return fmt.Errorf("view call %s of surface %s is not served", call.Command, fields.Surface)
	}
	if call.Command == "runtime.status.unwatch" {
		delete(view.watches, fields.Name)
		answer(nil, nil)
		return nil
	}
	value, err := s.registry.Read(fields.Name)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("status %s: %w", fields.Name, err)
	}
	view.watches[fields.Name] = string(encoded)
	answer(nil, nil)
	s.pushView(call.Surface, view, "status", map[string]any{"name": fields.Name, "value": value})
	return nil
}

// pushWatches sends each view the statuses it follows whose value changed.
func (s *Shell) pushWatches() {
	for surface, view := range s.surfaces.views {
		for name, last := range view.watches {
			value, err := s.registry.Read(name)
			if err != nil {
				s.fail(fmt.Errorf("status %s of surface %s: %w", name, surface, err))
				continue
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				s.fail(fmt.Errorf("status %s of surface %s: %w", name, surface, err))
				continue
			}
			if string(encoded) == last {
				continue
			}
			view.watches[name] = string(encoded)
			s.pushView(surface, view, "status", map[string]any{"name": name, "value": value})
		}
	}
}

// surfaceTextSize is the text scale of the tab surface: the frame factor multiplied by the factor of its card.
func (s *Shell) surfaceTextSize(surface string) (float64, error) {
	card := s.cardOfTab(surface)
	if card == "" {
		return 0, fmt.Errorf("surface %s is not in the layout", surface)
	}
	data, err := s.cardData(card)
	if err != nil {
		return 0, err
	}
	return s.frameText * data.CardTextSize(), nil
}

// declaresCommand tells whether the plugin declares the command name, in plugin.json or in its diagnostic declarations.
func (u *installedUnit) declaresCommand(name string) bool {
	entries := slices.Clone(u.Exposes.Commands)
	var diagnostics struct {
		Exposes surfaceMarks `json:"exposes"`
	}
	if json.Unmarshal(u.Diagnostics, &diagnostics) == nil { // silent: a plugin without diagnostic declarations has no such commands.
		entries = append(entries, diagnostics.Exposes.Commands...)
	}
	for _, raw := range entries {
		var entry struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &entry) == nil && entry.Name == name {
			return true
		}
	}
	return false
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
	delete(s.surfaces.views, event.Surface)
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
	event, err := decode[surfaceEvent](data[0])
	if err != nil {
		s.fail(fmt.Errorf("surface pressed: %w", err))
		return
	}
	for _, card := range s.plane.Cards() {
		if held, err := s.cardData(card.ID); err == nil && held != nil {
			for _, tab := range held.TabList() {
				if tab.ID == event.Surface && s.focused != card.ID {
					s.focused = card.ID
					s.options.Invalidate()
				}
			}
		}
	}
}
