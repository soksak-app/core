package workbench

import (
	"encoding/json"
	"fmt"
	"sort"
	"sync"
)

// Command is the handler of a declared command. params is the JSON of its parameters, which is empty when it has none.
type Command func(params json.RawMessage) (any, error)

// Status reads the current value of a declared status.
type Status func() any

// Registry holds the commands and the statuses of the workbench. Registering a name that is not declared is a programming error,
// which make exposure-check also finds in the sources, so it panics.
type Registry struct {
	declared *Declarations
	mu       sync.Mutex
	commands map[string]Command
	statuses map[string]Status
}

// NewRegistry returns an empty registry of the names of declared.
func NewRegistry(declared *Declarations) *Registry {
	return &Registry{declared: declared, commands: map[string]Command{}, statuses: map[string]Status{}}
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
		return nil, fmt.Errorf("command %s is not registered", name)
	}
	return run(params)
}

// Read returns the current value of the status name.
func (r *Registry) Read(name string) (any, error) {
	r.mu.Lock()
	read := r.statuses[name]
	r.mu.Unlock()
	if read == nil {
		return nil, fmt.Errorf("status %s is not registered", name)
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
