package host

import "sync/atomic"

// Quit is whether the application is quitting. The quit begins when the host asks the ready windows to close and
// ends when the page of a window keeps a modified tab (docs/spec/plugins.md#tab-reports); each change is idempotent.
type Quit struct {
	active atomic.Bool
}

// Begin marks the application as quitting.
func (q *Quit) Begin() { q.active.Store(true) }

// Cancel marks the application as not quitting.
func (q *Quit) Cancel() { q.active.Store(false) }

// Active reports whether the application is quitting.
func (q *Quit) Active() bool { return q.active.Load() }

// Request runs quit, which asks the application to end, for a quit request. The quit state is begun by Request, so every quit
// request begins it, with or without a ready window (docs/spec/hosts.md#process-lifecycle).
func (q *Quit) Request(quit func()) {
	q.Begin()
	quit()
}

// BeginRequest begins the quit state for an operating system quit request and reports whether the application quits at once, which it
// does when no ready window exists. ready is the number of ready windows that the request asks to close. Every quit request begins
// the state, with or without a ready window (docs/spec/hosts.md#process-lifecycle).
func (q *Quit) BeginRequest(ready int) bool {
	q.Begin()
	return ready == 0
}
