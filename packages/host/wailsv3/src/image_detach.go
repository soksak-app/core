package host

import (
	"encoding/json"
	"fmt"
	"time"
)

const imageDetachTimeout = 10 * time.Second

type imageDetachWaiter struct {
	target imageDetachTarget
	owner  SidecarOwner
	result chan imageDetachResult
}

type imageDetachResult struct {
	ok                bool
	result            string
	error             string
	currentGeneration *uint64
}

type imageDetachAck struct {
	Request           string  `json:"request"`
	Name              string  `json:"name"`
	Generation        uint64  `json:"generation"`
	OK                bool    `json:"ok"`
	Result            string  `json:"result"`
	Error             string  `json:"error"`
	CurrentGeneration *uint64 `json:"currentGeneration,omitempty"`
}

type pendingImageDetach struct {
	target imageDetachTarget
	id     string
	result <-chan imageDetachResult
}

func (c *Sidecars) beginImageDetach(target imageDetachTarget) (string, <-chan imageDetachResult, error) {
	if target.Owner == nil || target.Surface == "" || target.Name == "" || target.Sidecar == "" || target.Generation == 0 {
		return "", nil, fmt.Errorf("image detach sidecar %s surface %s image %s generation %d has an incomplete target",
			target.Sidecar, target.Surface, target.Name, target.Generation)
	}
	c.mu.Lock()
	if c.imageDetachRequests == nil {
		c.imageDetachRequests = map[string]*imageDetachWaiter{}
	}
	if c.nextImageDetachRequest == ^uint64(0) {
		c.mu.Unlock()
		return "", nil, fmt.Errorf("image detach sidecar %s surface %s image %s generation %d request identifier limit reached",
			target.Sidecar, target.Surface, target.Name, target.Generation)
	}
	c.nextImageDetachRequest++
	request := fmt.Sprintf("image-detach-%d", c.nextImageDetachRequest)
	waiter := &imageDetachWaiter{target: target, owner: target.Owner, result: make(chan imageDetachResult, 1)}
	c.imageDetachRequests[request] = waiter
	c.mu.Unlock()

	body, err := json.Marshal(map[string]any{"image": map[string]any{"detach": map[string]any{
		"request": request, "name": target.Name, "generation": target.Generation,
	}}})
	if err == nil {
		err = c.Send(target.Owner, target.Sidecar, target.Surface, body)
	}
	if err != nil {
		c.mu.Lock()
		delete(c.imageDetachRequests, request)
		c.mu.Unlock()
		return "", nil, fmt.Errorf("image detach sidecar %s surface %s image %s generation %d request %s: %w",
			target.Sidecar, target.Surface, target.Name, target.Generation, request, err)
	}
	return request, waiter.result, nil
}

func (c *Sidecars) handleImageDetachAck(owner SidecarOwner, sidecar, surface string, ack imageDetachAck) bool {
	if ack.OK && (ack.Error != "" || (ack.Result != "detached" && ack.Result != "alreadyDetached" && ack.Result != "alreadyAbsent")) {
		LogError("sidecar "+sidecar, fmt.Sprintf("invalid successful image detach acknowledgement %q for surface %s", ack.Request, surface))
		return true
	}
	if !ack.OK && ack.Error == "" {
		LogError("sidecar "+sidecar, fmt.Sprintf("failed image detach acknowledgement %q has no error for surface %s", ack.Request, surface))
		return true
	}
	c.mu.Lock()
	waiter, found := c.imageDetachRequests[ack.Request]
	if !found {
		c.mu.Unlock()
		LogError("sidecar "+sidecar, fmt.Sprintf("image detach acknowledgement has no pending request %q for surface %s", ack.Request, surface))
		return true
	}
	target := waiter.target
	if waiter.owner != owner || target.Sidecar != sidecar || target.Surface != surface || target.Name != ack.Name || target.Generation != ack.Generation {
		c.mu.Unlock()
		LogError("sidecar "+sidecar, fmt.Sprintf("image detach acknowledgement %q does not match its owner, surface, name, or generation", ack.Request))
		return true
	}
	delete(c.imageDetachRequests, ack.Request)
	c.mu.Unlock()
	waiter.result <- imageDetachResult{ok: ack.OK, result: ack.Result, error: ack.Error, currentGeneration: ack.CurrentGeneration}
	return true
}

func (c *Sidecars) detachImages(targets []imageDetachTarget) error {
	if len(targets) == 0 {
		return nil
	}
	timeout := c.imageDetachTimeout
	if timeout <= 0 {
		timeout = imageDetachTimeout
	}
	deadline := time.Now().Add(timeout)
	requests := make([]pendingImageDetach, 0, len(targets))
	for _, target := range targets {
		id, result, err := c.beginImageDetach(target)
		if err != nil {
			c.cancelImageDetaches(requests)
			return err
		}
		requests = append(requests, pendingImageDetach{target: target, id: id, result: result})
	}
	for _, request := range requests {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			c.cancelImageDetaches(requests)
			return imageDetachTimeoutError(request.target, request.id)
		}
		timer := time.NewTimer(remaining)
		select {
		case result := <-request.result:
			timer.Stop()
			if !result.ok {
				c.cancelImageDetaches(requests)
				reason := result.error
				if result.currentGeneration != nil {
					reason = fmt.Sprintf("%s (current generation %d)", reason, *result.currentGeneration)
				}
				return fmt.Errorf("image detach sidecar %s surface %s image %s generation %d request %s rejected: %s",
					request.target.Sidecar, request.target.Surface, request.target.Name, request.target.Generation, request.id, reason)
			}
			if result.result != "detached" && result.result != "alreadyDetached" && result.result != "alreadyAbsent" {
				c.cancelImageDetaches(requests)
				return fmt.Errorf("image detach sidecar %s surface %s image %s generation %d request %s returned invalid result %q",
					request.target.Sidecar, request.target.Surface, request.target.Name, request.target.Generation, request.id, result.result)
			}
		case <-timer.C:
			c.cancelImageDetaches(requests)
			return imageDetachTimeoutError(request.target, request.id)
		}
	}
	return nil
}

func (s *Surfaces) awaitImageDetaches(targets []imageDetachTarget) error {
	s.imageDetachMu.Lock()
	defer s.imageDetachMu.Unlock()
	for _, target := range targets {
		found := false
		for _, pending := range s.pendingImageDetaches {
			if pending.Surface == target.Surface && pending.Name == target.Name && pending.Sidecar == target.Sidecar && pending.Generation == target.Generation {
				found = true
				break
			}
		}
		if !found {
			s.pendingImageDetaches = append(s.pendingImageDetaches, target)
		}
	}
	if len(s.pendingImageDetaches) == 0 {
		return nil
	}
	if s.sidecars == nil {
		target := s.pendingImageDetaches[0]
		return fmt.Errorf("page reload image detach sidecar %s surface %s image %s generation %d: sidecar transport is unavailable",
			target.Sidecar, target.Surface, target.Name, target.Generation)
	}
	if err := s.sidecars.detachImages(s.pendingImageDetaches); err != nil {
		return err
	}
	s.pendingImageDetaches = nil
	return nil
}

func imageDetachTimeoutError(target imageDetachTarget, request string) error {
	return fmt.Errorf("image detach sidecar %s surface %s image %s generation %d request %s timed out",
		target.Sidecar, target.Surface, target.Name, target.Generation, request)
}

func (c *Sidecars) cancelImageDetaches(requests []pendingImageDetach) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, request := range requests {
		delete(c.imageDetachRequests, request.id)
	}
}

func (c *Sidecars) failImageDetaches(sidecar, reason string) {
	c.mu.Lock()
	var failed []*imageDetachWaiter
	for request, waiter := range c.imageDetachRequests {
		if sidecar != "" && waiter.target.Sidecar != sidecar {
			continue
		}
		delete(c.imageDetachRequests, request)
		failed = append(failed, waiter)
	}
	c.mu.Unlock()
	for _, waiter := range failed {
		waiter.result <- imageDetachResult{error: reason}
	}
}
