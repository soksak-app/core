package host

import (
	"sync"
	"sync/atomic"
)

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

// responseOwner is the response context of the endpoint request whose native work is running, such as the menu item that
// host.menu.select performs. A quit that the system requests during that work follows the response of that request, so the
// client receives the response before the endpoint closes (docs/spec/endpoint.md#responses-and-termination).
var responseOwner struct {
	// work runs one owned native work at a time, so a quit request names the request whose work caused it.
	work  sync.Mutex
	mu    sync.Mutex
	owned bool
	reply *ReplyScope
}

// WithResponseOwner runs work, the native work of an endpoint request, with reply as the owner of the quit requests that
// the work causes. A nil reply owns them with no response, so they run at once.
func WithResponseOwner(reply *ReplyScope, work func() error) error {
	responseOwner.work.Lock()
	defer responseOwner.work.Unlock()
	responseOwner.mu.Lock()
	responseOwner.owned, responseOwner.reply = true, reply
	responseOwner.mu.Unlock()
	defer func() {
		responseOwner.mu.Lock()
		responseOwner.owned, responseOwner.reply = false, nil
		responseOwner.mu.Unlock()
	}()
	return work()
}

// AfterOwnerResponse runs quit after the response of the endpoint request whose native work is running, and at once when
// no such work runs or its request has no response.
func AfterOwnerResponse(quit func()) {
	responseOwner.mu.Lock()
	owned, reply := responseOwner.owned, responseOwner.reply
	responseOwner.mu.Unlock()
	if !owned {
		quit()
		return
	}
	reply.AfterResponse(func(ReplyOutcome) { quit() })
}
