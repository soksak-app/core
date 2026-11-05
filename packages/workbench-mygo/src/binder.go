package workbench

import (
	"encoding/json"
	"fmt"

	"github.com/egoist/mygo/ui"
)

// Exposed is the key of an element that the binder made: its element name and its command. Item tells the elements of one name
// apart, as the tabs of a card, so each keeps its own state among its siblings.
type Exposed struct {
	Name, Command, Item string
}

// Binder connects each interactive element of the workbench to a declared command and gives it its element name when it creates
// the element (docs/spec/hosts.md#workbench).
type Binder struct {
	registry *Registry
	failed   func(command string, err error)
	// focus gives the elements of the binder to the command core.focus.set and the status core.focus.
	focus *Focus
}

// NewBinder returns the binder of registry. failed receives each command of an element that fails.
func NewBinder(registry *Registry, failed func(command string, err error)) *Binder {
	return &Binder{registry: registry, failed: failed}
}

// Press creates a button without a look that runs command with params, and gives it the element name name. item tells it from
// the elements of the same name. Add its look and its children to the element that it returns.
func (b *Binder) Press(c *ui.Context, name, command, item string, params any) ui.Element {
	return b.Bound(ui.ButtonBase(b.next(c, name, command, item)).OnClick(func() { b.run(command, params) }), name)
}

// Keyboard gives the binder the keyboard focus of its window.
func (b *Binder) Keyboard(focus *Focus) { b.focus = focus }

// Bound gives a widget of the element name name to the keyboard focus of the window, which reaches it by that name.
func (b *Binder) Bound(element ui.Element, name string) ui.Element {
	if b.focus == nil {
		return element
	}
	return b.focus.Bind(element, name)
}

// Control gives the next widget of c its element name and command, for a widget that takes its input as it is created. It returns
// the function that runs the command with the value of the widget.
func (b *Binder) Control(c *ui.Context, name, command, item string) func(params any) {
	b.next(c, name, command, item)
	return func(params any) { b.run(command, params) }
}

// next keys the next element of c, and refuses a name or a command that is not declared.
func (b *Binder) next(c *ui.Context, name, command, item string) *ui.Context {
	if !b.registry.declared.Elements[name] {
		panic(fmt.Sprintf("element name %s is not declared", name))
	}
	if !b.registry.declared.Commands[command] {
		panic(fmt.Sprintf("command %s is not declared", command))
	}
	return c.Key(Exposed{Name: name, Command: command, Item: item})
}

// run runs command with params and hands a failure to the binder.
func (b *Binder) run(command string, params any) {
	var raw json.RawMessage
	if params != nil {
		encoded, err := json.Marshal(params)
		if err != nil {
			b.fail(command, err)
			return
		}
		raw = encoded
	}
	b.registry.RunLater(command, raw, func(_ any, err error) {
		if err != nil {
			b.fail(command, err)
		}
	})
}

func (b *Binder) fail(command string, err error) {
	if b.failed != nil {
		b.failed(command, err)
	}
}

// interactive are the actions that make an element of the element tree interactive (docs/spec/hosts.md#workbench).
const interactive = ui.ActionPress | ui.ActionIncrement | ui.ActionDecrement | ui.ActionSetValue | ui.ActionExpand

// Unbound is an interactive element that has no command or no element name, in the form that core.workbench.audit gives on every host.
type Unbound struct {
	Role    string `json:"role"`
	Expose  string `json:"expose"`
	Command string `json:"command"`
	Text    string `json:"text"`
}

// Audit lists each interactive element of tree that has no command or no element name.
func Audit(tree []ui.ElementNode) []Unbound {
	var unbound []Unbound
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			exposed, _ := node.Key.(Exposed) // silent: an element without this key is unbound, which the zero value reports.
			// The panel of a popup catches the presses on it, and it is no control.
			if node.Actions&interactive != 0 && node.Role != ui.RolePopup && (exposed.Name == "" || exposed.Command == "") {
				unbound = append(unbound, Unbound{Role: AriaRole(node.Role), Expose: exposed.Name, Command: exposed.Command, Text: node.Label})
			}
			walk(node.Children)
		}
	}
	walk(tree)
	return unbound
}
