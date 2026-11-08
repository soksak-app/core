package host

import (
	"context"
	"errors"
	"sync"
)

const maxSourceGeneration = uint64(1<<53 - 1)

// sourceOrigins assigns each view incarnation one window-wide generation.
type sourceOrigins struct {
	mu    sync.Mutex
	floor uint64
	views map[string]uint64
	// absences owns only in-flight window requests, never historical surfaces.
	absences map[string]map[*sourceAbsence]struct{}
}

type sourceAbsence struct {
	origins *sourceOrigins
	surface string
	invalid bool // read and written only under origins.mu
}

// watchAbsence captures one background lifetime. A same-surface registration
// ends it permanently, even if that view retires before the request resumes.
func (o *sourceOrigins) watchAbsence(surface string) (*sourceAbsence, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if _, mounted := o.views[surface]; mounted {
		return nil, errors.New("surface requires viewSidecarSend with its original source generation")
	}
	if o.absences == nil {
		o.absences = map[string]map[*sourceAbsence]struct{}{}
	}
	if o.absences[surface] == nil {
		o.absences[surface] = map[*sourceAbsence]struct{}{}
	}
	ticket := &sourceAbsence{origins: o, surface: surface}
	o.absences[surface][ticket] = struct{}{}
	return ticket, nil
}

func (ticket *sourceAbsence) release() {
	o := ticket.origins
	o.mu.Lock()
	defer o.mu.Unlock()
	delete(o.absences[ticket.surface], ticket)
	if len(o.absences[ticket.surface]) == 0 {
		delete(o.absences, ticket.surface)
	}
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
	for ticket := range o.absences[surface] {
		ticket.invalid = true
	}
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

// WithViewSource carries host-issued source identity through an internal Go
// call context. It is not a plugin parameter or a replacement for admission.
func WithViewSource(ctx context.Context, surface string, generation uint64) context.Context {
	return context.WithValue(ctx, viewSourceContextKey{}, viewSourceContext{surface: surface, generation: generation})
}

type viewSourceContextKey struct{}
type viewSourceContext struct {
	surface    string
	generation uint64
}

func viewSourceOf(ctx context.Context) (viewSourceContext, bool) {
	value, ok := ctx.Value(viewSourceContextKey{}).(viewSourceContext)
	return value, ok
}
