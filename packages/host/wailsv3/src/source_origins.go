package host

import (
	"fmt"
	"sync"
)

const maxSourceGeneration = uint64(1<<53 - 1)

// sourceOrigins assigns each plugin-host or view incarnation one window-wide generation.
type sourceOrigins struct {
	mu          sync.Mutex
	floor       uint64
	pluginHosts map[string]uint64
	views       map[string]uint64
}

type sourceOriginSnapshot struct {
	Floor       uint64            `json:"floor"`
	PluginHosts map[string]uint64 `json:"pluginHosts"`
	Views       map[string]uint64 `json:"views"`
}

func newSourceOrigins() *sourceOrigins {
	return &sourceOrigins{pluginHosts: map[string]uint64{}, views: map[string]uint64{}}
}

func (s *Surfaces) sourceOriginState() *sourceOrigins {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sourceOrigins == nil {
		s.sourceOrigins = newSourceOrigins()
	}
	return s.sourceOrigins
}

func (o *sourceOrigins) table(surface bool) map[string]uint64 {
	if surface {
		return o.views
	}
	return o.pluginHosts
}

// create assigns and publishes a new source generation before the provider page loads.
func (o *sourceOrigins) create(identity string, surface bool) (uint64, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.floor >= maxSourceGeneration {
		return 0, fmt.Errorf("source generation exceeds JavaScript safe integer maximum %d", maxSourceGeneration)
	}
	o.floor++
	generation := o.floor
	o.table(surface)[identity] = generation
	return generation, nil
}

// retire removes only the source generation that ended; the floor retains every issued generation.
func (o *sourceOrigins) retire(identity string, surface bool, generation uint64) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	table := o.table(surface)
	if table[identity] != generation {
		return false
	}
	delete(table, identity)
	return true
}

func (o *sourceOrigins) current(identity string, surface bool) (uint64, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	generation, ok := o.table(surface)[identity]
	return generation, ok
}

// snapshot copies the floor and active source maps while holding the same lock as create and retire.
func (o *sourceOrigins) snapshot() sourceOriginSnapshot {
	o.mu.Lock()
	defer o.mu.Unlock()
	copyMap := func(source map[string]uint64) map[string]uint64 {
		result := make(map[string]uint64, len(source))
		for identity, generation := range source {
			result[identity] = generation
		}
		return result
	}
	return sourceOriginSnapshot{Floor: o.floor, PluginHosts: copyMap(o.pluginHosts), Views: copyMap(o.views)}
}
