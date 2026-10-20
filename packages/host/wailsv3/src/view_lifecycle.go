package host

import (
	"time"
	"unsafe"
)

// viewRestartLimit is the number of failures of one view surface within viewRestartWindow that stops its restarts
// (docs/plans/plugin-processes.md, rule 5, pass value (vi)).
const viewRestartLimit = 4

// viewRestartWindow is the sliding window of the failures of one view surface. A failure older than the window is not counted.
const viewRestartWindow = 300 * time.Second

// viewSpec is the record of one view surface that the host needs to create its view again. directory and folder are resolved
// when the view is first created.
type viewSpec struct {
	native    unsafe.Pointer
	plugin    string
	page      string
	directory string
	folder    string
	visible   bool
}

// viewLifecycle counts the failures of each view surface and keeps the record that creates its view again. now is the clock of the
// failures; the tests replace it. The host calls it on the UI thread only.
type viewLifecycle struct {
	now      func() time.Time
	specs    map[string]*viewSpec
	failures map[string][]time.Time
	stopped  map[string]bool
}

// newViewLifecycle returns the lifecycle of the view surfaces with the clock now.
func newViewLifecycle(now func() time.Time) *viewLifecycle {
	return &viewLifecycle{now: now, specs: map[string]*viewSpec{}, failures: map[string][]time.Time{}, stopped: map[string]bool{}}
}

// track records the view of surface and returns its record. A record of another plugin is replaced, so its folder is resolved again.
func (l *viewLifecycle) track(surface string, native unsafe.Pointer, plugin, page string, visible bool) *viewSpec {
	spec := l.specs[surface]
	if spec == nil || spec.plugin != plugin {
		spec = &viewSpec{plugin: plugin}
		l.specs[surface] = spec
	}
	spec.native, spec.page, spec.visible = native, page, visible
	return spec
}

// fail records a failure of the view of surface at the time of the clock and reports whether the view may be created again.
// The fourth failure within viewRestartWindow stops the restarts, and a stopped surface records no further failure.
func (l *viewLifecycle) fail(surface string) bool {
	if l.stopped[surface] {
		return false
	}
	now := l.now()
	kept := make([]time.Time, 0, viewRestartLimit)
	for _, at := range l.failures[surface] {
		if now.Sub(at) < viewRestartWindow {
			kept = append(kept, at)
		}
	}
	kept = append(kept, now)
	l.failures[surface] = kept
	if len(kept) >= viewRestartLimit {
		l.stopped[surface] = true
		return false
	}
	return true
}

// isStopped reports whether the restarts of the view of surface are stopped.
func (l *viewLifecycle) isStopped(surface string) bool {
	return l.stopped[surface]
}

// forget removes the record of surface, which clears its failures and its stop. It runs when the surface is removed, so the next
// surface of the same name is a new view.
func (l *viewLifecycle) forget(surface string) {
	delete(l.specs, surface)
	delete(l.failures, surface)
	delete(l.stopped, surface)
}

// viewOverflow is the failure of a view whose message queue is full. Its text is the reason that the view reports.
type viewOverflow struct {
	reason string
}

func (e viewOverflow) Error() string { return e.reason }

// viewQueueFullPrefix starts the reason of a view.error message whose message queue is full (docs/spec/native-surfaces.md#view-surfaces).
const viewQueueFullPrefix = "queue full for "

// viewRecords returns the lifecycle of the view surfaces, which starts with the wall clock when the surface is first used.
func (s *Surfaces) viewRecords() *viewLifecycle {
	if s.lifecycle == nil {
		s.lifecycle = newViewLifecycle(time.Now)
	}
	return s.lifecycle
}
