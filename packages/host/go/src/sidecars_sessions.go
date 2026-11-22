package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
)

// errAnswerEnded rejects a call that waits for an answer of a persistent service whose connection ends before the answer
// (docs/spec/persistent-services.md#owned-sessions).
var errAnswerEnded = errors.New("the service connection ended before the answer")

// awaitKey names an awaited reply: the sidecar, the surface of the request and its correlation identifiers as a JSON list, which is the
// list of the reply that the service answers with the same identifiers.
type awaitKey struct {
	sidecar string
	surface string
	cids    string
}

func awaitKeyOf(sidecar, surface string, cids []string) awaitKey {
	raw, _ := json.Marshal(cids) // silent: a list of strings always marshals.
	return awaitKey{sidecar: sidecar, surface: surface, cids: string(raw)}
}

// awaitedReply is the answer of a sidecar to an awaited send: the body of its reply, or the failure that the reply body states or the
// failure of the sidecar that ended the wait.
type awaitedReply struct {
	body json.RawMessage
	err  error
}

// checkSendCids refuses a correlation identifier that a request line cannot hold (docs/spec/persistent-services.md#owned-session-messages).
func checkSendCids(cids []string) error {
	for _, cid := range cids {
		for _, c := range cid {
			if c < 0x20 || c == 0x7f || c == '"' || c == '\\' {
				return fmt.Errorf("sidecarSend cids are refused: %q is empty or holds a quote, a backslash or a control character", cid)
			}
		}
		if cid == "" {
			return fmt.Errorf("sidecarSend cids are refused: %q is empty or holds a quote, a backslash or a control character", cid)
		}
	}
	return nil
}

// IsPersistent tells whether the sidecar is declared as a persistent service.
func (c *Sidecars) IsPersistent(name string) bool {
	c.declarations.RLock()
	defer c.declarations.RUnlock()
	return c.persistent[name]
}

// OwnedSessions returns the owned sessions that the persistent service of the sidecar holds for the client, as the JSON array of the answer
// to the request `sessions` (docs/spec/persistent-services.md#owned-sessions). A sidecar whose service has no endpoint holds none.
func (c *Sidecars) OwnedSessions(name string) (json.RawMessage, error) {
	if name == "" {
		return nil, errors.New("sidecarSessions requires a non-empty sidecar")
	}
	request := fmt.Sprintf("%d", atomic.AddUint64(&c.nextRequest, 1))
	waiter := make(chan error, 1)
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return nil, errors.New("sidecars are stopped")
	}
	process, running := c.running[name]
	if !running {
		if !c.IsPersistent(name) {
			c.mu.Unlock()
			return nil, fmt.Errorf("sidecar %s is not a persistent service", name)
		}
		program, _, ok := c.declaration(name)
		if !ok {
			c.mu.Unlock()
			return nil, fmt.Errorf("sidecar %s is not declared", name)
		}
		endpoint := filepath.Join(c.configDir, "services", filepath.Base(program), "endpoint.json")
		if _, err := os.Stat(endpoint); errors.Is(err, os.ErrNotExist) {
			c.mu.Unlock()
			return json.RawMessage("[]"), nil
		} else if err != nil {
			c.mu.Unlock()
			return nil, fmt.Errorf("sidecar %s: read endpoint: %w", name, err)
		}
		started, _, err := c.process(name, nil)
		if err != nil {
			c.mu.Unlock()
			return nil, err
		}
		process = started
	}
	if !process.persistent {
		c.mu.Unlock()
		return nil, fmt.Errorf("sidecar %s is not a persistent service", name)
	}
	if process.readEnded {
		c.mu.Unlock()
		return nil, errAnswerEnded
	}
	process.closeWaiters[request] = waiter
	line, err := json.Marshal(map[string]string{"operation": "sessions", "request": request})
	if err != nil {
		delete(process.closeWaiters, request)
		c.mu.Unlock()
		return nil, err
	}
	line = append(line, '\n')
	select {
	case process.outbox <- queue(line, c.now()):
	default:
		delete(process.closeWaiters, request)
		c.mu.Unlock()
		return nil, fmt.Errorf("sidecar %s is not keeping up", name)
	}
	c.mu.Unlock()
	// The request ends by its answer or by the end of its connection; no time limit ends it, as for retain.
	if err := <-waiter; err != nil {
		c.mu.Lock()
		delete(process.listed, request)
		c.mu.Unlock()
		if errors.Is(err, errServiceDisconnected) {
			return nil, errAnswerEnded
		}
		return nil, err
	}
	c.mu.Lock()
	sessions, answered := process.listed[request]
	delete(process.listed, request)
	c.mu.Unlock()
	return validateSessions(sessions, answered)
}

// validateSessions checks the entries of an answer to sessions and returns the array (docs/spec/persistent-services.md#owned-sessions).
// An answer whose member sessions is missing is refused as missing.
func validateSessions(sessions json.RawMessage, answered bool) (json.RawMessage, error) {
	if !answered || len(sessions) == 0 {
		return nil, errors.New("invalid message: sessions is missing")
	}
	var list []map[string]json.RawMessage
	if err := json.Unmarshal(sessions, &list); err != nil || list == nil {
		return nil, errors.New("invalid message: sessions is not an array")
	}
	for _, entry := range list {
		for _, member := range []string{"session", "surface", "root", "creation"} {
			var text string
			if err := json.Unmarshal(entry[member], &text); err != nil || text == "" {
				return nil, fmt.Errorf("invalid message: sessions %s is not a non-empty string", member)
			}
		}
		var size map[string]json.RawMessage
		if err := json.Unmarshal(entry["size"], &size); err != nil || size == nil {
			return nil, errors.New("invalid message: sessions size is not an object")
		}
		for _, member := range []string{"width", "height", "scale"} {
			var value float64
			if err := json.Unmarshal(size[member], &value); err != nil || !(value > 0) {
				return nil, fmt.Errorf("invalid message: sessions size.%s is not a positive number", member)
			}
		}
	}
	return sessions, nil
}

// awaitSend sends a request that awaits its reply: it registers the waiter of cids for surface before send queues the line, so a reply
// that comes at once finds it, and it answers with the body of the reply that names the same identifiers. A reply body whose member
// error states a failure rejects the call with it (docs/spec/persistent-services.md#owned-session-messages).
func (c *Sidecars) awaitSend(ctx context.Context, sidecar, surface string, cids []string, send func() error) (json.RawMessage, error) {
	if len(cids) == 0 {
		return nil, errors.New("sidecarSend answer requires cids")
	}
	if err := checkSendCids(cids); err != nil {
		return nil, err
	}
	if !c.IsPersistent(sidecar) {
		return nil, errors.New("sidecarSend answer requires a persistent sidecar")
	}
	key := awaitKeyOf(sidecar, surface, cids)
	waiter, err := c.expectReply(key)
	if err != nil {
		return nil, err
	}
	if err := send(); err != nil {
		c.forgetReply(key)
		return nil, err
	}
	select {
	case answer := <-waiter:
		return answer.body, answer.err
	case <-ctx.Done():
		c.dropReply(key)
		return nil, ctx.Err()
	}
}

// expectReply registers the waiter of key. A waiting request with the same surface, sidecar and identifiers is refused.
func (c *Sidecars) expectReply(key awaitKey) (chan awaitedReply, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, waiting := c.awaited[key]; waiting {
		return nil, fmt.Errorf("sidecarSend answer cids already wait for surface %s", key.surface)
	}
	waiter := make(chan awaitedReply, 1)
	c.awaited[key] = waiter
	return waiter, nil
}

// forgetReply removes the waiter of key when its send was not queued.
func (c *Sidecars) forgetReply(key awaitKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.awaited, key)
}

// dropReply keeps the reply of key that arrives after the call ended, so that the reply is logged as late.
func (c *Sidecars) dropReply(key awaitKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, waiting := c.awaited[key]; waiting {
		delete(c.awaited, key)
		c.dropped[key] = true
	}
}

// deliverReply answers the waiter of the reply from sidecar for surface with the identifiers cids.
func (c *Sidecars) deliverReply(sidecar, surface string, cids []string, body json.RawMessage) {
	key := awaitKeyOf(sidecar, surface, cids)
	c.mu.Lock()
	waiter, waiting := c.awaited[key]
	if waiting {
		delete(c.awaited, key)
	}
	late := c.dropped[key]
	if late {
		delete(c.dropped, key)
	}
	c.mu.Unlock()
	if late {
		LogInfo("sidecar "+sidecar, "the sidecarSend reply arrived after its request ended")
	}
	if waiting {
		waiter <- awaitedReply{body: body, err: replyFailure(body)}
	}
}

// replyFailure returns the failure that a reply body states in its member error: a string as it is, another value as its JSON text.
func replyFailure(body json.RawMessage) error {
	var failed struct {
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &failed); err != nil || len(failed.Error) == 0 || string(failed.Error) == "null" {
		return nil
	}
	var text string
	if err := json.Unmarshal(failed.Error, &text); err != nil {
		return errors.New(string(failed.Error))
	}
	return errors.New(text)
}

// failAwaited ends the waiters of sidecar with err, because the sidecar failed or its connection ended before the reply.
func (c *Sidecars) failAwaited(sidecar string, err error) {
	c.mu.Lock()
	var waiters []chan awaitedReply
	for key, waiter := range c.awaited {
		if key.sidecar == sidecar {
			delete(c.awaited, key)
			waiters = append(waiters, waiter)
		}
	}
	for key := range c.dropped {
		if key.sidecar == sidecar {
			delete(c.dropped, key)
		}
	}
	c.mu.Unlock()
	for _, waiter := range waiters {
		waiter <- awaitedReply{err: err}
	}
}
