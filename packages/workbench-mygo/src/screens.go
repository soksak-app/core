package workbench

// The screens of the workbench are functions of values: each draws what it is given and runs commands only through a
// RunCommand, so a screen holds neither the registry nor a host call, and the shell connects both.

// ElementName is the key of an element: the dom name that exposure.json declares, and the position of the element among
// the elements of that name for a name that the declaration marks `many`.
type ElementName struct {
	Name  string
	Index int
}

// RunCommand runs the declared command name with params.
type RunCommand func(name string, params map[string]any)

// ElementNames gives the elements of one build their names in document order. The shell makes one for each build and passes
// it to every screen of the build, so the position of an element counts the elements of its name in every screen.
type ElementNames struct{ counts map[string]int }

// NewElementNames returns the names of one build.
func NewElementNames() *ElementNames { return &ElementNames{counts: map[string]int{}} }

// Next returns the name of the next element of the dom name.
func (n *ElementNames) Next(name string) ElementName {
	index := n.counts[name]
	n.counts[name] = index + 1
	return ElementName{Name: name, Index: index}
}
