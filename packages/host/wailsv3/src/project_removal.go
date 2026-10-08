package host

import (
	"fmt"
	"sync"
)

// Removals holds the requests that ask the window which shows a project whether the project may be removed
// (docs/spec/projects.md). A request resolves with the answer of that window, or with true when the window ends.
type Removals struct {
	mu      sync.Mutex
	pending map[string]removal
}

type removal struct {
	owner string
	reply chan bool
}

// Begin registers a request for the project id that the window owner is asked. The returned channel receives the
// answer once.
func (r *Removals) Begin(id, owner string) (<-chan bool, error) {
	if !validProjectID(id) {
		return nil, fmt.Errorf("project id %q is not valid", id)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, asked := r.pending[id]; asked {
		return nil, fmt.Errorf("removal of project %s is already being asked", id)
	}
	if r.pending == nil {
		r.pending = map[string]removal{}
	}
	reply := make(chan bool, 1)
	r.pending[id] = removal{owner: owner, reply: reply}
	return reply, nil
}

// Answer resolves the request for the project id.
func (r *Removals) Answer(id string, allowed bool) error {
	r.mu.Lock()
	asked, ok := r.pending[id]
	delete(r.pending, id)
	r.mu.Unlock()
	if !ok {
		return fmt.Errorf("removal of project %s is not being asked", id)
	}
	asked.reply <- allowed
	return nil
}

// Abandon resolves every request that the window owner has not answered with true, because a window that ends
// keeps no tab.
func (r *Removals) Abandon(owner string) {
	r.mu.Lock()
	var ended []chan bool
	for id, asked := range r.pending {
		if asked.owner == owner {
			ended = append(ended, asked.reply)
			delete(r.pending, id)
		}
	}
	r.mu.Unlock()
	for _, reply := range ended {
		reply <- true
	}
}
