package host

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
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
	// released names the end that ended the request without an acknowledgement; it is empty for an acknowledgement.
	released imageDetachRelease
}

// imageDetachRelease is the end that ends a pending detach without an acknowledgement.
type imageDetachRelease string

const (
	// releasedBySupplier ends the detaches of a supplier whose connection or host ended.
	releasedBySupplier imageDetachRelease = "supplier"
	// releasedBySession ends the detaches of a surface whose session ended with its tab.
	releasedBySession imageDetachRelease = "session"
)

type imageDetachAck struct {
	Request           string  `json:"request"`
	Name              string  `json:"name"`
	Generation        uint64  `json:"generation"`
	OK                bool    `json:"ok"`
	Result            string  `json:"result"`
	Error             string  `json:"error"`
	CurrentGeneration *uint64 `json:"currentGeneration,omitempty"`
}

// imageDetachKey names one image of a supplier; a window keeps at most one pending detach for it.
type imageDetachKey struct{ Sidecar, Surface, Name string }

// pendingImageDetach is a detach that a page start sent and whose acknowledgement has not arrived.
// timedOut is closed when the deadline error is recorded, and ended when the wait ends.
type pendingImageDetach struct {
	target   imageDetachTarget
	id       string
	timedOut chan struct{}
	ended    chan struct{}
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
	request := "image-detach-" + rand.Text()
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

// beginImageDetaches sends the detach of each target that no pending detach of the same image covers and returns without
// waiting: the barrier applies to each surface, which stays pending until its detach ends (docs/spec/sidecars.md).
func (s *Surfaces) beginImageDetaches(targets []imageDetachTarget) error {
	s.imageDetachMu.Lock()
	defer s.imageDetachMu.Unlock()
	for _, target := range targets {
		key := imageDetachKey{Sidecar: target.Sidecar, Surface: target.Surface, Name: target.Name}
		// No newer generation of a pending image can have been attached, so its pending detach covers this reload.
		if _, pending := s.imageDetaches[key]; pending {
			continue
		}
		if s.sidecars == nil {
			return fmt.Errorf("page reload image detach sidecar %s surface %s image %s generation %d: sidecar transport is unavailable",
				target.Sidecar, target.Surface, target.Name, target.Generation)
		}
		id, result, err := s.sidecars.beginImageDetach(target)
		if err != nil {
			return err
		}
		if s.imageDetaches == nil {
			s.imageDetaches = map[imageDetachKey]*pendingImageDetach{}
		}
		entry := &pendingImageDetach{target: target, id: id, timedOut: make(chan struct{}), ended: make(chan struct{})}
		s.imageDetaches[key] = entry
		routine.Go("image-detach-wait", func() { s.waitImageDetach(key, entry, result) })
	}
	return nil
}

// waitImageDetach waits for the end of one pending detach. The deadline is a timer because a supplier that does not answer
// sends no event; it records that failure and does not end the wait.
func (s *Surfaces) waitImageDetach(key imageDetachKey, entry *pendingImageDetach, result <-chan imageDetachResult) {
	timeout := s.sidecars.imageDetachTimeout
	if timeout <= 0 {
		timeout = imageDetachTimeout
	}
	defer close(entry.ended)
	timer := time.NewTimer(timeout)
	var outcome imageDetachResult
	select {
	case outcome = <-result:
		timer.Stop()
	case <-timer.C:
		LogError("image detach", imageDetachTimeoutError(entry.target, entry.id))
		close(entry.timedOut)
		outcome = <-result
	}
	target := entry.target
	failure := ""
	switch {
	case outcome.released == releasedBySession:
		// The tab of the surface is gone, so its end is told to no page.
	case outcome.released == releasedBySupplier:
		failure = fmt.Sprintf("image detach sidecar %s surface %s image %s generation %d request %s ended: the supplier connection ended",
			target.Sidecar, target.Surface, target.Name, target.Generation, entry.id)
	case !outcome.ok:
		reason := outcome.error
		if outcome.currentGeneration != nil {
			reason = fmt.Sprintf("%s (current generation %d)", reason, *outcome.currentGeneration)
		}
		failure = fmt.Sprintf("image detach sidecar %s surface %s image %s generation %d request %s rejected: %s",
			target.Sidecar, target.Surface, target.Name, target.Generation, entry.id, reason)
	}
	s.imageDetachMu.Lock()
	if s.imageDetaches[key] != entry {
		s.imageDetachMu.Unlock()
		return
	}
	delete(s.imageDetaches, key)
	if failure != "" {
		if s.imageDetachFailures == nil {
			s.imageDetachFailures = map[string]map[string]string{}
		}
		if s.imageDetachFailures[key.Surface] == nil {
			s.imageDetachFailures[key.Surface] = map[string]string{}
		}
		s.imageDetachFailures[key.Surface][key.Name] = failure
	}
	for _, other := range s.imageDetaches {
		if other.target.Surface == key.Surface {
			s.imageDetachMu.Unlock()
			return
		}
	}
	failures := s.imageDetachFailures[key.Surface]
	delete(s.imageDetachFailures, key.Surface)
	if outcome.released == releasedBySession {
		s.imageDetachMu.Unlock()
		return
	}
	// The end carries the failures of every detach of the surface in image-name order; the page shows them through its error
	// display, which writes the one record of each.
	names := make([]string, 0, len(failures))
	for name := range failures {
		names = append(names, name)
	}
	sort.Strings(names)
	var ended any
	if len(names) > 0 {
		texts := make([]string, len(names))
		for i, name := range names {
			texts[i] = failures[name]
		}
		ended = strings.Join(texts, "; ")
	}
	event := map[string]any{"surface": key.Surface, "error": ended}
	if !s.detachPageReady {
		s.endedImageDetaches = append(s.endedImageDetaches, event)
		s.imageDetachMu.Unlock()
		return
	}
	s.imageDetachMu.Unlock()
	s.windowEvent("image-detach-ended", event)
}

// pendingImageDetachError refuses an image attach or a page send of a surface that has a pending detach.
func (s *Surfaces) pendingImageDetachError(surface string) error {
	s.imageDetachMu.Lock()
	defer s.imageDetachMu.Unlock()
	for _, entry := range s.imageDetaches {
		if target := entry.target; target.Surface == surface {
			return fmt.Errorf("image detach sidecar %s surface %s image %s generation %d request %s is pending",
				target.Sidecar, target.Surface, target.Name, target.Generation, entry.id)
		}
	}
	return nil
}

// pendingImageDetachSurfaces returns the surfaces that have a pending detach, in order, for the start document.
func (s *Surfaces) pendingImageDetachSurfaces() []string {
	s.imageDetachMu.Lock()
	defer s.imageDetachMu.Unlock()
	surfaces := []string{}
	seen := map[string]bool{}
	for _, entry := range s.imageDetaches {
		if surface := entry.target.Surface; !seen[surface] {
			seen[surface] = true
			surfaces = append(surfaces, surface)
		}
	}
	sort.Strings(surfaces)
	return surfaces
}

// imageDetachPageStarting marks the page as not ready for the ends of detaches and clears the ends queued for the previous
// page, whose start document the new page does not read.
func (s *Surfaces) imageDetachPageStarting() {
	s.imageDetachMu.Lock()
	s.detachPageReady = false
	cleared := s.endedImageDetaches
	s.endedImageDetaches = nil
	s.imageDetachMu.Unlock()
	// No page shows the failures of a cleared end, so the host writes them.
	for _, event := range cleared {
		if failure, ok := event["error"].(string); ok {
			LogError("image detach", failure)
		}
	}
}

// imageDetachPageReady sends the ends of detaches that occurred while the page was starting.
func (s *Surfaces) imageDetachPageReady() {
	s.imageDetachMu.Lock()
	s.detachPageReady = true
	ended := s.endedImageDetaches
	s.endedImageDetaches = nil
	s.imageDetachMu.Unlock()
	for _, event := range ended {
		s.windowEvent("image-detach-ended", event)
	}
}

func imageDetachTimeoutError(target imageDetachTarget, request string) error {
	return fmt.Errorf("image detach sidecar %s surface %s image %s generation %d request %s timed out",
		target.Sidecar, target.Surface, target.Name, target.Generation, request)
}

// releaseImageDetachesLocked ends the pending detaches whose target match accepts. The caller holds c.mu; each result
// channel has one free slot, so the delivery does not block.
func (c *Sidecars) releaseImageDetachesLocked(release imageDetachRelease, match func(imageDetachTarget) bool) {
	for request, waiter := range c.imageDetachRequests {
		if match(waiter.target) {
			delete(c.imageDetachRequests, request)
			waiter.result <- imageDetachResult{released: release}
		}
	}
}

// failImageDetaches ends the pending detaches of sidecar, or of every sidecar when sidecar is empty, because the supplier
// connection or the host ended.
func (c *Sidecars) failImageDetaches(sidecar string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.releaseImageDetachesLocked(releasedBySupplier, func(target imageDetachTarget) bool { return sidecar == "" || target.Sidecar == sidecar })
}
