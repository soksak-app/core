//go:build diagnostics

// Object counts of a window for the diagnostic method diagnostics.objects (docs/spec/endpoint.md). Each count reads a registry of the host, and
// the Rust host (packages/host/tauriv2/src/object_counts.rs) uses the same names and definitions.

package host

import "unsafe"

// HostObjects are the objects that the host process keeps for one window. Regions are the image regions and Documents are the document regions
// (docs/spec/native-surfaces.md#regions). SidecarSessions are the sessions of the sidecars that the surfaces of the window use. PendingReplies are
// the requests of the window that wait for a reply: the sidecar requests with correlation identifiers and the page requests of the relay.
// EventSubscribers are the subscriptions of the connections to the notifications of the window.
type HostObjects struct {
	Surfaces, Regions, Documents, SidecarSessions, PendingReplies, EventSubscribers int64
}

// Payload returns the counts with the names of the reply.
func (c HostObjects) Payload() map[string]int64 {
	return map[string]int64{
		"surfaces": c.Surfaces, "regions": c.Regions, "documents": c.Documents,
		"sidecarSessions": c.SidecarSessions, "pendingReplies": c.PendingReplies, "eventSubscribers": c.EventSubscribers,
	}
}

// PageObjects are the elements of the main document of a page and the documents of the page, which are the main document and its frames.
type PageObjects struct {
	Elements, Documents int64
}

// Payload returns the counts with the names of the reply.
func (c PageObjects) Payload() map[string]int64 {
	return map[string]int64{"elements": c.Elements, "documents": c.Documents}
}

// Count returns the number of names of the document regions of the window, including the names whose document is being created.
func (d *Documents) Count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.handles)
}

// Attached returns the document regions whose document is created. A name that is being created has no document and is not returned.
func (d *Documents) Attached() map[DocumentKey]unsafe.Pointer {
	d.mu.Lock()
	defer d.mu.Unlock()
	attached := make(map[DocumentKey]unsafe.Pointer, len(d.handles))
	for key, handle := range d.handles {
		if handle != nil {
			attached[key] = handle
		}
	}
	return attached
}

// Count returns the number of image regions of the window, including the regions that are being created.
func (i *Images) Count() int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return len(i.handles)
}

// SessionCount returns the number of sidecar sessions of the surfaces that owner owns. A surface that sent a request to a running sidecar
// counts once for that sidecar.
func (c *Sidecars) SessionCount(owner SidecarOwner) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	count := 0
	for _, process := range c.running {
		for surface := range process.surfaces {
			if c.owners[surface] == owner {
				count++
			}
		}
	}
	return count
}

// PendingCount returns the number of sidecar requests with correlation identifiers that wait for a reply and whose surface owner owns.
func (c *Sidecars) PendingCount(owner SidecarOwner) int {
	surfaces := c.requests.surfaces()
	c.mu.Lock()
	defer c.mu.Unlock()
	count := 0
	for _, surface := range surfaces {
		if c.owners[surface] == owner {
			count++
		}
	}
	return count
}

// surfaces returns the surface of each request that waits for a reply.
func (l *requestLedger) surfaces() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	surfaces := make([]string, 0, len(l.pending))
	for _, request := range l.pending {
		surfaces = append(surfaces, request.surface)
	}
	return surfaces
}

// SubscriberCount returns the number of subscriptions of the connections to the notifications of window.
func (e *Endpoint) SubscriberCount(window string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	count := 0
	for t, subscribers := range e.counts {
		if t.window == window {
			count += subscribers
		}
	}
	return count
}

// Pending returns the number of requests that wait for a reply and whose target match accepts.
func (r *Relay[T]) Pending(match func(T) bool) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for _, waiter := range r.waiting {
		if match(waiter.target) {
			count++
		}
	}
	return count
}
