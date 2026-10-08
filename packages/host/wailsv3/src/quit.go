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
