package host

import (
	"errors"
	"sync"
)

const maxSourceGeneration = uint64(1<<53 - 1)

// sourceOrigins assigns each view incarnation one window-wide generation.
type sourceOrigins struct {
	mu    sync.Mutex
	floor uint64
	views map[string]uint64
}

type sourceOriginSnapshot struct {
	Floor uint64            `json:"floor"`
	Views map[string]uint64 `json:"views"`
}

func newSourceOrigins() *sourceOrigins {
	return &sourceOrigins{views: map[string]uint64{}}
}

func (s *Surfaces) sourceOriginState() *sourceOrigins {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sourceOrigins == nil {
		s.sourceOrigins = newSourceOrigins()
	}
	return s.sourceOrigins
}

// create assigns and publishes a new view generation before the provider page loads.
func (o *sourceOrigins) create(surface string) (uint64, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.floor >= maxSourceGeneration {
		return 0, errors.New("view source generation exceeds the JavaScript safe integer limit")
	}
	o.floor++
	generation := o.floor
	o.views[surface] = generation
	return generation, nil
}

// retire removes only the view generation that ended; the floor retains every issued generation.
func (o *sourceOrigins) retire(surface string, generation uint64) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.views[surface] != generation {
		return false
	}
	delete(o.views, surface)
	return true
}

func (o *sourceOrigins) current(surface string) (uint64, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	generation, ok := o.views[surface]
	return generation, ok
}

// snapshot copies the floor and active view generations while holding the same lock as create and retire.
func (o *sourceOrigins) snapshot() sourceOriginSnapshot {
	o.mu.Lock()
	defer o.mu.Unlock()
	views := make(map[string]uint64, len(o.views))
	for surface, generation := range o.views {
		views[surface] = generation
	}
	return sourceOriginSnapshot{Floor: o.floor, Views: views}
}
