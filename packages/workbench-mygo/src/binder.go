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
	// pointer takes the clicks of the elements, and focus holds the elements that a command can focus, when the binder belongs to a window.
	pointer *PointerSequence
	focus   *Focus
}

// NewBinder returns the binder of registry. failed receives each command of an element that fails.
func NewBinder(registry *Registry, failed func(command string, err error)) *Binder {
	return &Binder{registry: registry, failed: failed}
}

// Attach gives the binder the pointer sequence and the focus of its window.
func (b *Binder) Attach(pointer *PointerSequence, focus *Focus) { b.pointer, b.focus = pointer, focus }

// Watched gives the presses in element, a root of the workbench or an overlay, to the pointer sequence of the window.
func (b *Binder) Watched(element ui.Element) ui.Element {
	if b.pointer == nil {
		return element
	}
	return b.pointer.Watch(element)
}

// Bound gives a widget of the element name name to the keyboard focus of the window, which reaches it by that name.
func (b *Binder) Bound(element ui.Element, name string) ui.Element {
	if b.focus == nil {
		return element
	}
	return b.focus.Bind(element, name)
}

// Press creates a button without a look that runs command with params, and gives it the element name name. item tells it from
// the elements of the same name. Add its look and its children to the element that it returns.
func (b *Binder) Press(c *ui.Context, name, command, item string, params any) ui.Element {
	return b.Bound(ui.ButtonBase(b.next(c, name, command, item, params)).OnClick(func() {
		if b.pointer != nil {
			b.pointer.Click(name)
		}
		b.run(command, params)
	}), name)
}

// PressOn creates a button without a look that runs the plugin command command with no parameter on surface, and gives it the element
// name name, as a section action does (docs/spec/plugins.md#sections). A failure goes to the binder.
func (b *Binder) PressOn(c *ui.Context, name, command, item, surface string) ui.Element {
	if !b.registry.declared.Elements[name] {
		panic(fmt.Sprintf("element name %s is not declared", name))
	}
	return b.Bound(ui.ButtonBase(c.Key(Exposed{Name: name, Command: command, Item: item})).OnClick(func() {
		if b.pointer != nil {
			b.pointer.Click(name)
		}
		b.registry.RunOn(command, json.RawMessage(`{}`), surface, func(_ any, err error) {
			if err != nil {
				b.fail(command, err)
			}
		})
	}), name)
}

// Absent creates an element that the window holds but does not show, as the page holds an element under display:none. It keeps the
// index of its name and takes the press of a request, and it has no size, so neither the pointer nor the keyboard stops at it.
func (b *Binder) Absent(c *ui.Context, name, command, item string, params any) ui.Element {
	if b.focus != nil {
		b.focus.Hold(name)
	}
	return ui.Box(b.next(c, name, command, item, params)).Size(0, 0).Role(ui.RoleButton).OnClick(func() { b.run(command, params) })
}

// Control gives the next widget of c its element name and command, for a widget that takes its input as it is created. It returns
// the function that runs the command with the value of the widget.
func (b *Binder) Control(c *ui.Context, name, command, item string) func(params any) {
	b.next(c, name, command, item, nil)
	return func(params any) { b.run(command, params) }
}

// Frame starts the elements of a frame: the params of the elements of the last frame are dropped, and each element that the frame keys
// records its own. The window calls it at the start of each frame.
func (b *Binder) Frame() { clear(b.registry.params) }

// next keys the next element of c with the params of its command, for the window snapshot (docs/spec/exposure.md#window-snapshot),
// and refuses a name or a command that is not declared.
func (b *Binder) next(c *ui.Context, name, command, item string, params any) *ui.Context {
	if !b.registry.declared.Elements[name] {
		panic(fmt.Sprintf("element name %s is not declared", name))
	}
	if !b.registry.declared.Commands[command] {
		panic(fmt.Sprintf("command %s is not declared", command))
	}
	key := Exposed{Name: name, Command: command, Item: item}
	b.registry.params[key] = params
	return c.Key(key)
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
	unbound := []Unbound{}
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			// The list box of a select and its options are parts of the select, whose trigger holds the name and the command,
			// as the options of a select of the page are no controls of their own.
			if node.Role == ui.RoleList {
				continue
			}
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

// Declares reports whether command is a declared command of the exposure; an action of a notice whose command is not declared is not drawn.
func (b *Binder) Declares(command string) bool { return b.registry.declared.Commands[command] }

// PressStep is one command that a press runs, with its parameters.
type PressStep struct {
	Command string
	Params  any
}

// PressAll is a press that runs its steps in order, as a press of a notice entry reads it and, for a card entry, focuses the card
// (docs/spec/notifications.md#notice-center). Each step must be a declared command.
func (b *Binder) PressAll(c *ui.Context, name, item string, steps ...PressStep) ui.Element {
	for _, step := range steps {
		if !b.registry.declared.Commands[step.Command] {
			panic(fmt.Sprintf("command %s is not declared", step.Command))
		}
	}
	first := steps[0]
	return b.Bound(ui.ButtonBase(b.next(c, name, first.Command, item, first.Params)).OnClick(func() {
		if b.pointer != nil {
			b.pointer.Click(name)
		}
		for _, step := range steps {
			b.run(step.Command, step.Params)
		}
	}), name)
}
