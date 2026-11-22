package host

import (
	"fmt"
	"time"
	"unsafe"
)

// viewRestartLimit is the number of failures of one view surface within viewRestartWindow that stops its restarts
// (docs/spec/plugin-processes.md, rule 5, pass value (vi)).
const viewRestartLimit = 4

// viewRestartWindow is the sliding window of the failures of one view surface. A failure older than the window is not counted.
const viewRestartWindow = 300 * time.Second

// viewSpec is the record of one view surface that the host needs to create its view again. directory and folder are resolved
// from installed.json each time the view is created.
type viewSpec struct {
	native    unsafe.Pointer
	plugin    string
	page      string
	directory string
	folder    string
	visible   bool
	// The start values of the view, which the host injects again when it creates the view again.
	start ViewStart
	// committedURL is the URL that the native view committed since its previous end, which the next end record states. It is empty when
	// no document committed since then.
	committedURL string
}

// viewStopReason is the reason of a view that stopped its restarts: the log line and the view-stopped event carry it. The window is
// written in whole seconds, as the Tauri host writes it.
func viewStopReason() string {
	return fmt.Sprintf("the view failed %d times within %d seconds and is created again when its tab is reopened", viewRestartLimit, int(viewRestartWindow/time.Second))
}

// viewLifecycle counts the failures of each view surface and keeps the record that creates its view again. The failures are instants
// that the caller passes, so the decision is a function of its inputs. The host calls it on the UI thread only.
type viewLifecycle struct {
	specs    map[string]*viewSpec
	failures map[string][]time.Time
	stopped  map[string]bool
	// live holds the surfaces whose view is alive: tracked and not yet ended, so an end is recorded once.
	live map[string]bool
}

// newViewLifecycle returns the lifecycle of the view surfaces, which holds no clock.
func newViewLifecycle() *viewLifecycle {
	return &viewLifecycle{specs: map[string]*viewSpec{}, failures: map[string][]time.Time{}, stopped: map[string]bool{}, live: map[string]bool{}}
}

// track records the view of surface and returns its record. A record of another plugin is replaced, so its folder is resolved again.
func (l *viewLifecycle) track(surface string, native unsafe.Pointer, plugin, page string, visible bool) *viewSpec {
	l.live[surface] = true
	spec := l.specs[surface]
	if spec == nil || spec.plugin != plugin {
		spec = &viewSpec{plugin: plugin}
		l.specs[surface] = spec
	}
	spec.native, spec.page, spec.visible = native, page, visible
	return spec
}

// fail records a failure of the view of surface at the instant now and reports whether the view may be created again.
// The fourth failure within viewRestartWindow stops the restarts, and a stopped surface records no further failure.
func (l *viewLifecycle) fail(surface string, now time.Time) bool {
	if l.stopped[surface] {
		return false
	}
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
// reset clears the failures and the stop of the view of surface, so its next failure starts a new count. The view record stays.
func (l *viewLifecycle) reset(surface string) {
	delete(l.failures, surface)
	delete(l.stopped, surface)
}

func (l *viewLifecycle) forget(surface string) {
	delete(l.live, surface)
	delete(l.specs, surface)
	delete(l.failures, surface)
	delete(l.stopped, surface)
}

// recordEnd stores host.view.killed for the view of surface, which the host observes to end, and names the caller that ended it
// (the causes are listed in docs/spec/host-contract.md under host.view.killed.is-written-on-every-end). An end is stored once: a surface without a
// live view, or a view that already ended, stores nothing.
func (l *viewLifecycle) recordEnd(surface, caller string) {
	if !l.live[surface] {
		return
	}
	delete(l.live, surface)
	if spec := l.specs[surface]; spec != nil {
		EmitHost(LevelWarn, "host.view.killed", viewKilledFields(surface, spec.plugin, caller, spec.committedURL))
		spec.committedURL = ""
	}
}

// noteCommitted records the URL of the document that the native view of surface committed. It runs on the UI thread before the commit
// closes the documents of the view, so the end record of that view states the URL.
func (l *viewLifecycle) noteCommitted(surface, url string) {
	if spec := l.specs[surface]; spec != nil {
		spec.committedURL = url
	}
}

// viewKilledFields are the fields of host.view.killed: the plugin and the surface of the view, the caller that ended it, the committed
// url when a document committed since the previous end, and unsent true, because the records of the view that the writer did not
// receive may be lost and the event states that loss (docs/spec/logging.md#principles).
func viewKilledFields(surface, plugin, caller, url string) map[string]any {
	fields := map[string]any{"plugin": plugin, "surface": surface, "caller": caller, "unsent": true}
	if url != "" {
		fields["url"] = url
	}
	return fields
}

// viewOverflow is the failure of a view whose message queue is full. Its text is the reason that the view reports.
type viewOverflow struct {
	reason string
}

func (e viewOverflow) Error() string { return e.reason }

// viewQueueFullPrefix starts the reason of a view.error message whose message queue is full (docs/spec/native-surfaces.md#view-surfaces).
const viewQueueFullPrefix = "queue full for "

// viewRecords returns the lifecycle of the view surfaces, which is created when the surface is first used.
func (s *Surfaces) viewRecords() *viewLifecycle {
	if s.lifecycle == nil {
		s.lifecycle = newViewLifecycle()
	}
	return s.lifecycle
}
