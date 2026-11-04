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
