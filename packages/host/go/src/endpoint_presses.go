// The presses of the endpoint connections and the ends of the producers of watches.
//
// A press belongs to the endpoint connection whose down delivered it, and the close of that connection releases every press
// that it still owns (docs/spec/exposure.md#methods). A watch ends with status.ended when its producer ends: the surface of
// the watch closes or its document is replaced, or its window closes.

package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

// pressKey names a press: the window, the pointer and the button of its down.
type pressKey struct{ window, pointer, button string }

// releasing marks a press whose release is being delivered, so no second release of it starts.
const releasing = -1

// openPress is a press that a delivered down opened and no delivered up ended yet.
type openPress struct {
	owner *endpointConn
	// x and y are the point of the last delivered down or drag of the press, and clicks the click count of its down.
	x, y   float64
	clicks int
	// waits is the code of the refusal that the release of a closed owner waits to be lifted, codeButtonHeld or
	// codePointerHeld, releasing while the release is delivered, and 0 while the owner is open.
	waits int
}

// pointerDelivered records the change of the presses that a delivered input of connection c makes: a down opens a press that
// c owns, a drag moves its point and an up ends it, from any connection. A down that c delivered while it closed is released
// at once, as its close releases every other press of it.
func (e *Endpoint) pointerDelivered(c *endpointConn, window string, input PointerInput) {
	key := pressKey{window, input.Pointer, input.Button}
	ended, closed := false, false
	e.pressMu.Lock()
	if e.presses == nil {
		e.presses = map[pressKey]*openPress{}
	}
	switch input.Phase {
	case "down":
		e.presses[key] = &openPress{owner: c, x: input.X, y: input.Y, clicks: input.Clicks}
		closed = c != nil && c.pressesReleased
	case "drag":
		if p := e.presses[key]; p != nil {
			p.x, p.y = input.X, input.Y
		}
	case "up":
		delete(e.presses, key)
		ended = true
	}
	e.pressMu.Unlock()
	if closed {
		e.releasePresses(c)
	}
	if ended {
		e.retryReleases(codePointerHeld)
	}
}

// releasePresses releases every press that connection c owns, in the turn of its close. Later downs of c are released when
// they are delivered.
func (e *Endpoint) releasePresses(c *endpointConn) {
	e.pressMu.Lock()
	c.pressesReleased = true
	keys := e.takeReleases(func(p *openPress) bool { return p.owner == c && p.waits == 0 })
	e.pressMu.Unlock()
	for _, key := range keys {
		e.release(key)
	}
}

// retryReleases delivers the releases that wait for the lift of the refusal code: the change of host.buttons to mask 0 lifts
// codeButtonHeld and the end of a press lifts codePointerHeld.
func (e *Endpoint) retryReleases(code int) {
	e.pressMu.Lock()
	keys := e.takeReleases(func(p *openPress) bool { return p.waits == code })
	e.pressMu.Unlock()
	for _, key := range keys {
		e.release(key)
	}
}

// takeReleases marks the presses that match as releasing and returns their keys in a fixed order. pressMu is held.
func (e *Endpoint) takeReleases(match func(*openPress) bool) []pressKey {
	var keys []pressKey
	for key, p := range e.presses {
		if match(p) {
			p.waits = releasing
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.window != b.window {
			return a.window < b.window
		}
		if a.pointer != b.pointer {
			return a.pointer < b.pointer
		}
		return a.button < b.button
	})
	return keys
}

// release delivers the up of the press key at the point of its last delivered down or drag, as a person's release. A release
// refused with codeButtonHeld or codePointerHeld waits for the lift of that refusal; a release refused in another way finds the
// press ended already and ends nothing. Both are written to the application log at the level info.
func (e *Endpoint) release(key pressKey) {
	e.pressMu.Lock()
	p := e.presses[key]
	e.pressMu.Unlock()
	if p == nil {
		return
	}
	clicks := p.clicks
	if clicks < 1 {
		clicks = 1
	}
	err := e.backend.Pointer(key.window, PointerInput{Pointer: key.pointer, X: p.x, Y: p.y, Phase: "up", Button: key.button, Clicks: clicks})
	code := 0
	var coded *RPCError
	if errors.As(err, &coded) {
		code = coded.Code
	}
	waits := err != nil && (code == codeButtonHeld || code == codePointerHeld)
	e.pressMu.Lock()
	// A delivered up of another connection may have ended the press while its release was delivered.
	current := e.presses[key] == p
	if current && waits {
		p.waits = code
	} else if current {
		delete(e.presses, key)
	}
	e.pressMu.Unlock()
	if err == nil {
		e.retryReleases(codePointerHeld)
		return
	}
	outcome := "ends nothing"
	if waits && current {
		outcome = "waits"
	}
	LogInfo("endpoint press", fmt.Sprintf("the release of the press of pointer %s button %s in window %s of a closed connection %s: %d %v",
		key.pointer, key.button, key.window, outcome, code, err))
}

// buttonsChanged retries the releases that wait for host.buttons to become mask 0.
func (e *Endpoint) buttonsChanged(value any) {
	fields, ok := value.(map[string]any)
	if !ok {
		return
	}
	if mask, ok := fields["mask"].(uint64); ok && mask == 0 {
		e.retryReleases(codeButtonHeld)
	}
}

// ProducerEnded ends the watches whose producer ended (docs/spec/exposure.md#methods): those with surface in window when surface
// is not empty, and every watch of window otherwise. In the order of the queue of each topic, each connection that holds the
// watch receives one status.ended {window, name, surface?, reason}, after the status.changed sent to it before, and the watch is
// removed without a status.unwatch to the page. A diagnostic subscription is no status watch and stays. ProducerEnded does
// not block.
func (e *Endpoint) ProducerEnded(window, surface, reason string) {
	ends := func(t topic) bool {
		if t.window != window || (surface != "" && t.surface != surface) {
			return false
		}
		_, diagnostic := diagnosticTopics[t.name]
		return !diagnostic
	}
	set := map[topic]bool{}
	e.mu.Lock()
	for t := range e.counts {
		if ends(t) {
			set[t] = true
		}
	}
	e.mu.Unlock()
	// A first watch that waits in its queue subscribes before the end runs, so its topic ends too.
	e.queueMu.Lock()
	for t := range e.queues {
		if ends(t) {
			set[t] = true
		}
	}
	e.queueMu.Unlock()
	topics := make([]topic, 0, len(set))
	for t := range set {
		topics = append(topics, t)
	}
	sort.Slice(topics, func(i, j int) bool {
		if topics[i].name != topics[j].name {
			return topics[i].name < topics[j].name
		}
		return topics[i].surface < topics[j].surface
	})
	for _, t := range topics {
		e.enqueue(t, false, func() { e.endTopic(t, reason) })
	}
}

// endTopic removes topic t from the connections that hold it and sends each of them status.ended. A connection that closed
// before keeps its subscription until its own release runs, so the count keeps it.
func (e *Endpoint) endTopic(t topic, reason string) {
	params := map[string]any{"window": t.window, "name": t.name, "reason": reason}
	if t.surface != "" {
		params["surface"] = t.surface
	}
	data, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "status.ended", "params": params})
	if err != nil {
		LogError("endpoint notification", err)
		return
	}
	e.mu.Lock()
	var targets []*endpointConn
	for c := range e.conns {
		if c.topics[t] {
			delete(c.topics, t)
			targets = append(targets, c)
		}
	}
	if e.counts[t] -= len(targets); e.counts[t] <= 0 {
		delete(e.counts, t)
	}
	e.mu.Unlock()
	for _, c := range targets {
		c.send(data, "notification status.ended")
	}
}
