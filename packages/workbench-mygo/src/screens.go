package workbench

import "github.com/egoist/mygo/ui"

// The screens of the workbench are functions of values: each draws what it is given and runs commands only through a Binder, so a
// screen holds neither the registry nor a host call, and the shell connects both.

// ElementName is the key of an element: the dom name that exposure.json declares, and the position of the element among
// the elements of that name for a name that the declaration marks `many`.
type ElementName struct {
	Name  string
	Index int
}

// elementName is the element name of the key of an element, or "" for a key that names none.
func elementName(key any) string {
	switch named := key.(type) {
	case ElementName:
		return named.Name
	case Exposed:
		return named.Name
	}
	return ""
}

// RunCommand runs the declared command name with params.
type RunCommand func(name string, params map[string]any)

// ElementNames gives the elements of one build their names in document order.
type ElementNames struct{ counts map[string]int }

// NewElementNames returns the names of one build.
func NewElementNames() *ElementNames { return &ElementNames{counts: map[string]int{}} }

// Next returns the name of the next element of the dom name.
func (n *ElementNames) Next(name string) ElementName {
	index := n.counts[name]
	n.counts[name] = index + 1
	return ElementName{Name: name, Index: index}
}

// Name gives the next element of c its element name, for an element that runs no command. item tells it from the elements of the
// same name.
func (b *Binder) Name(c *ui.Context, name, item string) *ui.Context {
	if !b.registry.declared.Elements[name] {
		panic("element name " + name + " is not declared")
	}
	return c.Key(Exposed{Name: name, Item: item})
}
