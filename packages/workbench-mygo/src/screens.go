package workbench

import "github.com/egoist/mygo/ui"

// The screens of the workbench are functions of values: each draws what it is given and runs commands only through a Binder, so a
// screen holds neither the registry nor a host call, and the shell connects both.

// elementName is the element name of the key of an element, or "" for a key that names none.
func elementName(key any) string {
	if named, ok := key.(Exposed); ok {
		return named.Name
	}
	return ""
}

// Name gives the next element of c its element name, for an element that runs no command. item tells it from the elements of the
// same name.
func (b *Binder) Name(c *ui.Context, name, item string) *ui.Context {
	if !b.registry.declared.Elements[name] {
		panic("element name " + name + " is not declared")
	}
	return c.Key(Exposed{Name: name, Item: item})
}

// Button draws a button of the theme with the text label, which runs command with params.
func (b *Binder) Button(c *ui.Context, name, command, item, label string, params any) ui.Element {
	run := b.Control(c, name, command, item)
	button := ui.Button(c, label)
	if button.Clicked() {
		run(params)
	}
	return button
}
