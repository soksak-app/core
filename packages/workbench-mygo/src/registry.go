package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"regexp"
	"sort"
	"sync"

	"github.com/egoist/mygo/ui"
)

// Command is the handler of a declared command. params is the JSON of its parameters, which is empty when it has none.
type Command func(params json.RawMessage) (any, error)

// Status reads the current value of a declared status.
type Status func() any

// The codes of the failures of a request (docs/spec/exposure.md#errors).
const (
	Failed        = -32000
	UnknownMethod = -32601
	InvalidParams = -32602
	UnknownName   = 1001
	Unregistered  = 1002
)

// Refusal is the failure of a request with its code. A command returns one to choose the code of its failure; any other error of
// a command answers with the code Failed.
type Refusal struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (r *Refusal) Error() string { return r.Message }

// Refuse returns the refusal with code and the formatted message.
func Refuse(code int, format string, values ...any) *Refusal {
	return &Refusal{Code: code, Message: fmt.Sprintf(format, values...)}
}

// Elements are the elements of a window: its element tree and the actions on it. Both run on the main thread, outside a frame.
type Elements interface {
	ElementTree() ([]ui.ElementNode, error)
	ActElement(id uint64, action ui.Actions, text string) error
}

// Changed receives the value of a watched status.
type Changed func(name string, value any)

// watch is one watched status: its receiver and the JSON of the value that it last received.
type watch struct {
	changed Changed
	text    []byte
	value   any
}

// Registry holds the commands and the statuses of the workbench. Registering a name that is not declared is a programming error,
// which make exposure-check also finds in the sources, so it panics.
type Registry struct {
	declared *Declarations
	mu       sync.Mutex
	commands map[string]Command
	statuses map[string]Status
	watches  map[string]*watch
	elements Elements
}

// NewRegistry returns an empty registry of the names of declared.
func NewRegistry(declared *Declarations) *Registry {
	return &Registry{declared: declared, commands: map[string]Command{}, statuses: map[string]Status{}, watches: map[string]*watch{}}
}

// Command registers the handler of the declared command name.
func (r *Registry) Command(name string, run Command) {
	if !r.declared.Commands[name] {
		panic(fmt.Sprintf("command %s is not declared", name))
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.commands[name] != nil {
		panic(fmt.Sprintf("command %s is already registered", name))
	}
	r.commands[name] = run
}

// Status registers the reader of the declared status name.
func (r *Registry) Status(name string, read Status) {
	if !r.declared.Statuses[name] {
		panic(fmt.Sprintf("status %s is not declared", name))
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.statuses[name] != nil {
		panic(fmt.Sprintf("status %s is already registered", name))
	}
	r.statuses[name] = read
}

// Run runs the command name with params.
func (r *Registry) Run(name string, params json.RawMessage) (any, error) {
	r.mu.Lock()
	run := r.commands[name]
	r.mu.Unlock()
	if run == nil {
		return nil, Refuse(Unregistered, "command %s is not registered", name)
	}
	return run(params)
}

// Read returns the current value of the status name.
func (r *Registry) Read(name string) (any, error) {
	r.mu.Lock()
	read := r.statuses[name]
	r.mu.Unlock()
	if read == nil {
		return nil, Refuse(Unregistered, "status %s is not registered", name)
	}
	return read(), nil
}

// Names returns the registered commands and statuses, each sorted.
func (r *Registry) Names() (commands, statuses []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for name := range r.commands {
		commands = append(commands, name)
	}
	for name := range r.statuses {
		statuses = append(statuses, name)
	}
	sort.Strings(commands)
	sort.Strings(statuses)
	return commands, statuses
}

// methodKinds gives the entry kind that each request method handles.
var methodKinds = map[string]string{
	"status.get": "status", "status.watch": "status", "status.unwatch": "status",
	"command.run": "command", "dom.rect": "dom", "dom.act": "dom",
}

// causeID is the form of a correlation identifier of the cause of a request (docs/spec/exposure.md#requests).
var causeID = regexp.MustCompile(`^[^"\\\x00-\x1f\x7f]+$`)

// Answer answers one request of the relay (docs/spec/exposure.md#relay) with its result, or with a Refusal in the words of the page.
// A status that the request starts to watch sends its values to changed.
func (r *Registry) Answer(method string, params json.RawMessage, changed Changed) (any, error) {
	if method == "exposure.list" {
		return r.list()
	}
	kind, known := methodKinds[method]
	if !known {
		return nil, Refuse(UnknownMethod, "unknown method %s", method)
	}
	var fields map[string]json.RawMessage
	var name *string
	if json.Unmarshal(params, &fields) != nil || json.Unmarshal(fields["name"], &name) != nil || name == nil {
		return nil, Refuse(InvalidParams, "%s requires name", method)
	}
	if !map[string]map[string]bool{"status": r.declared.Statuses, "command": r.declared.Commands, "dom": r.declared.Elements}[kind][*name] {
		return nil, Refuse(UnknownName, "unknown %s %s", kind, *name)
	}
	switch method {
	case "status.get":
		return r.Read(*name)
	case "status.watch":
		return nil, r.watch(*name, changed)
	case "status.unwatch":
		r.mu.Lock()
		delete(r.watches, *name)
		r.mu.Unlock()
		return nil, nil
	case "command.run":
		return r.runRequest(*name, fields)
	}
	if fields["address"] != nil {
		if fields["index"] != nil {
			return nil, Refuse(InvalidParams, "a request gives index or address, not both")
		}
		return nil, Refuse(InvalidParams, "dom %s takes no address", *name)
	}
	element, err := r.element(*name, fields["index"])
	if err != nil {
		return nil, err
	}
	if method == "dom.rect" {
		return map[string]any{"x": element.Bounds.X, "y": element.Bounds.Y, "width": element.Bounds.W, "height": element.Bounds.H,
			"zoom": 1, "document": map[string]any{"x": 0, "y": 0}}, nil
	}
	return nil, r.act(*name, element, fields)
}

// Elements gives the registry the elements of its window. Without them a declared element name has no element.
func (r *Registry) Elements(elements Elements) { r.elements = elements }

// drawn returns the elements of the last frame by their element names, each name in tree order.
func (r *Registry) drawn() (map[string][]ui.ElementNode, error) {
	named := map[string][]ui.ElementNode{}
	if r.elements == nil {
		return named, nil
	}
	tree, err := r.elements.ElementTree()
	if err != nil {
		return nil, Refuse(Failed, "%v", err)
	}
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if name := elementName(node.Key); name != "" {
				named[name] = append(named[name], node)
			}
			walk(node.Children)
		}
	}
	walk(tree)
	return named, nil
}

// element returns the element that a request names.
func (r *Registry) element(name string, index json.RawMessage) (ui.ElementNode, error) {
	var none ui.ElementNode
	drawn, err := r.drawn()
	if err != nil {
		return none, err
	}
	list := drawn[name]
	if len(list) == 0 {
		return none, Refuse(Unregistered, "dom %s has no element", name)
	}
	if !r.declared.many[name] && len(list) > 1 {
		return none, Refuse(Unregistered, "dom %s has %d elements", name, len(list))
	}
	position := 0
	if index != nil {
		var number any
		if json.Unmarshal(index, &number) != nil {
			return none, Refuse(InvalidParams, "index must be a non-negative integer")
		}
		value, ok := number.(float64)
		if !ok || value < 0 || value != math.Trunc(value) {
			return none, Refuse(InvalidParams, "index must be a non-negative integer")
		}
		if value >= float64(len(list)) {
			return none, Refuse(Unregistered, "dom %s has no element at index %v", name, value)
		}
		position = int(value)
	}
	return list[position], nil
}

// act performs the action of a request on element. The action works as assistive technology performs it, in the next frame.
func (r *Registry) act(name string, element ui.ElementNode, fields map[string]json.RawMessage) error {
	action := "undefined"
	if raw, present := fields["action"]; present && json.Unmarshal(raw, &action) != nil {
		return Refuse(InvalidParams, "unknown action %s", raw)
	}
	switch action {
	case "click":
		if element.Actions&ui.ActionPress == 0 {
			return Refuse(Failed, "dom %s takes no click", name)
		}
		return r.perform(name, element, ui.ActionPress, "")
	case "input":
		var value *string
		if json.Unmarshal(fields["value"], &value) != nil || value == nil {
			return Refuse(InvalidParams, "input requires a string value")
		}
		if element.Actions&ui.ActionSetValue == 0 {
			return Refuse(Failed, "dom %s takes no input", name)
		}
		return r.perform(name, element, ui.ActionSetValue, *value)
	case "dispatch":
		return Refuse(Failed, "the mygo workbench has no DOM events")
	}
	return Refuse(InvalidParams, "unknown action %s", action)
}

func (r *Registry) perform(name string, element ui.ElementNode, action ui.Actions, text string) error {
	if err := r.elements.ActElement(element.ID, action, text); err != nil {
		return Refuse(Failed, "dom %s: %v", name, err)
	}
	return nil
}

// runRequest runs the command of a request after the checks of the page, in their order.
func (r *Registry) runRequest(name string, fields map[string]json.RawMessage) (any, error) {
	r.mu.Lock()
	registered := r.commands[name] != nil
	r.mu.Unlock()
	if !registered {
		return nil, Refuse(Unregistered, "command %s is not registered", name)
	}
	var input map[string]any
	if json.Unmarshal(fields["params"], &input) != nil || input == nil {
		return nil, Refuse(InvalidParams, "command.run for %s requires params", name)
	}
	if !MatchesSchema(r.declared.params[name], input) {
		return nil, Refuse(InvalidParams, "invalid params for %s", name)
	}
	// The handlers of the workbench take no cause, and an invalid list is refused also for a handler that ignores it.
	if cids, present := fields["cids"]; present && !validCauses(cids) {
		return nil, Refuse(InvalidParams, "command.run for %s: command cids must be an array of non-empty strings without a quote, a backslash or a control character", name)
	}
	return r.Run(name, fields["params"])
}

// validCauses reports whether cids is a list of correlation identifiers.
func validCauses(cids json.RawMessage) bool {
	var list []any
	if json.Unmarshal(cids, &list) != nil || list == nil {
		return false
	}
	for _, cid := range list {
		if text, ok := cid.(string); !ok || !causeID.MatchString(text) {
			return false
		}
	}
	return true
}

// list gives the declarations in the format of the declaration file, each with its registration.
func (r *Registry) list() (map[string][]map[string]any, error) {
	drawn, err := r.drawn()
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	registered := map[string]func(name string) bool{
		"status":   func(name string) bool { return r.statuses[name] != nil },
		"commands": func(name string) bool { return r.commands[name] != nil },
		"dom":      func(name string) bool { return len(drawn[name]) > 0 },
	}
	out := map[string][]map[string]any{}
	for key, entries := range r.declared.exposes {
		listed := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			row := make(map[string]any, len(entry)+1)
			maps.Copy(row, entry)
			row["registered"] = registered[key](entry["name"].(string))
			listed = append(listed, row)
		}
		out[key] = listed
	}
	return out, nil
}

// watch starts to send the values of the status name to changed, beginning with the current value. A status that is already
// watched takes the new receiver and sends it the last value.
func (r *Registry) watch(name string, changed Changed) error {
	r.mu.Lock()
	read := r.statuses[name]
	current := r.watches[name]
	if read != nil && current != nil {
		current.changed = changed
	}
	r.mu.Unlock()
	if read == nil {
		return Refuse(Unregistered, "status %s is not registered", name)
	}
	if current != nil {
		changed(name, current.value)
		return nil
	}
	current = &watch{changed: changed}
	r.mu.Lock()
	r.watches[name] = current
	r.mu.Unlock()
	return r.send(name, current, read())
}

// send gives the receiver of a watch the value when it differs from the last value.
func (r *Registry) send(name string, watched *watch, value any) error {
	text, err := json.Marshal(value)
	if err != nil {
		return Refuse(Failed, "status %s value: %v", name, err)
	}
	if watched.text != nil && string(text) == string(watched.text) {
		return nil
	}
	watched.text, watched.value = text, value
	watched.changed(name, value)
	return nil
}

// Changed sends the watched statuses whose value changed. The workbench calls it in a step, after a change of its state.
func (r *Registry) Changed() error {
	type entry struct {
		name    string
		watched *watch
		read    Status
	}
	r.mu.Lock()
	entries := make([]entry, 0, len(r.watches))
	for name, watched := range r.watches {
		entries = append(entries, entry{name, watched, r.statuses[name]})
	}
	r.mu.Unlock()
	var failures []error
	for _, each := range entries {
		failures = append(failures, r.send(each.name, each.watched, each.read()))
	}
	return errors.Join(failures...)
}
