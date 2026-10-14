package host

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

// RunningCalls holds the host calls of each window that have not returned. A reload of a page waits until every call that
// the page sent has its reply (docs/spec/native-host.md#page-reload), so a reload that times out names the calls of its
// window that still run.
type RunningCalls struct {
	mu    sync.Mutex
	next  uint64
	calls map[uint64]runningCall
}

type runningCall struct {
	window  string
	name    string
	started time.Time
}

// NewRunningCalls returns an empty set of running calls.
func NewRunningCalls() *RunningCalls {
	return &RunningCalls{calls: map[uint64]runningCall{}}
}

// Begin records that the call name of window started at, and returns the identifier that End takes.
func (r *RunningCalls) Begin(window, name string, at time.Time) uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	r.calls[r.next] = runningCall{window: window, name: name, started: at}
	return r.next
}

// End records that the call returned.
func (r *RunningCalls) End(id uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.calls, id)
}

// Of names the running calls of window in the order of their start, each with the seconds it has run at now, or "none".
func (r *RunningCalls) Of(window string, now time.Time) string {
	r.mu.Lock()
	running := make([]runningCall, 0, len(r.calls))
	for _, call := range r.calls {
		if call.window == window {
			running = append(running, call)
		}
	}
	r.mu.Unlock()
	if len(running) == 0 {
		return "none"
	}
	slices.SortFunc(running, func(a, b runningCall) int { return a.started.Compare(b.started) })
	names := make([]string, len(running))
	for i, call := range running {
		names[i] = fmt.Sprintf("%s %.1fs", call.name, now.Sub(call.started).Seconds())
	}
	return strings.Join(names, ", ")
}

// ReloadTimeoutText is the error of a reload whose page did not report ready within timeout, with the running calls of its
// window.
func ReloadTimeoutText(timeout time.Duration, running string) string {
	return fmt.Sprintf("the reloaded page did not report ready within %s; running host calls: %s", timeout, running)
}

// runningCalls holds the host calls of every window of the process.
var runningCalls = NewRunningCalls()
