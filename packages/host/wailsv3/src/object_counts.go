//go:build diagnostics

// Object counts of a window for the diagnostic method diagnostics.objects (docs/spec/endpoint.md). Each count reads a registry of the host, and
// the Rust host (packages/host/tauriv2/src/object_counts.rs) uses the same names and definitions.

package host

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"runtime/metrics"
	"runtime/pprof"
	"slices"
	"sort"
	"time"
	"unsafe"
)

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

// DocumentObjects are the counts of the document region Key.
type DocumentObjects struct {
	Key    DocumentKey
	Counts PageObjects
}

// ObjectCounts are the object counts of one window that diagnostics.objects replies. ParkedElements are the elements of the parked surface
// hosts of the main page, which are outside its document and so not in Page.
type ObjectCounts struct {
	Host           HostObjects
	Page           PageObjects
	ParkedElements int64
	Documents      []DocumentObjects
	Sessions       []SidecarSession
}

// ObjectCounter is the diagnostic backend of diagnostics.objects: it counts the objects of an existing window. The application host
// implements it, and tests of the method give a backend with fixed counts.
type ObjectCounter interface {
	ObjectCounts(window string) (ObjectCounts, error)
}

// Payload returns the counts with the names of the reply, with the documents ordered by surface and document.
func (c ObjectCounts) Payload() map[string]any {
	documents := slices.Clone(c.Documents)
	sort.Slice(documents, func(i, j int) bool {
		a, b := documents[i].Key, documents[j].Key
		if a.Surface != b.Surface {
			return a.Surface < b.Surface
		}
		return a.Name < b.Name
	})
	list := make([]map[string]any, 0, len(documents))
	for _, document := range documents {
		list = append(list, map[string]any{
			"surface": document.Key.Surface, "document": document.Key.Name,
			"elements": document.Counts.Elements, "documents": document.Counts.Documents,
		})
	}
	sessions := c.Sessions
	if sessions == nil {
		sessions = []SidecarSession{}
	}
	page := c.Page.Payload()
	page["parkedElements"] = c.ParkedElements
	return map[string]any{"host": c.Host.Payload(), "page": page, "documents": list, "sessions": sessions}
}

// surfaceCount returns the number of surfaces of the window, which is the number of their native views. It runs on the UI thread, which
// changes the views.
func (s *Surfaces) surfaceCount() int {
	return len(s.views)
}

// runtimeMetrics are the figures of the Go runtime that the reply field `runtime` of diagnostics.objects holds, by reply name. The Go runtime
// keeps its heap, its goroutine stacks and its collector metadata in memory that the system reports as untagged VM_ALLOCATE, so these
// figures divide that memory; the Rust host has no such runtime and leaves the field out (docs/spec/host-contract.md).
var runtimeMetrics = []struct{ reply, metric string }{
	{"heapObjectsBytes", "/memory/classes/heap/objects:bytes"},
	{"heapUnusedBytes", "/memory/classes/heap/unused:bytes"},
	{"heapFreeBytes", "/memory/classes/heap/free:bytes"},
	{"heapReleasedBytes", "/memory/classes/heap/released:bytes"},
	{"stacksBytes", "/memory/classes/heap/stacks:bytes"},
	{"metadataOtherBytes", "/memory/classes/metadata/other:bytes"},
	{"heapGoalBytes", "/gc/heap/goal:bytes"},
	{"goroutines", "/sched/goroutines:goroutines"},
}

// RuntimeMemory reads the figures of runtimeMetrics. A metric that the runtime does not provide is an error that names it.
func RuntimeMemory() (map[string]uint64, error) {
	samples := make([]metrics.Sample, len(runtimeMetrics))
	for i, m := range runtimeMetrics {
		samples[i].Name = m.metric
	}
	metrics.Read(samples)
	figures := make(map[string]uint64, len(samples))
	for i, sample := range samples {
		if sample.Value.Kind() != metrics.KindUint64 {
			return nil, fmt.Errorf("the Go runtime does not provide the metric %s", sample.Name)
		}
		figures[runtimeMetrics[i].reply] = sample.Value.Uint64()
	}
	return figures, nil
}

// WriteHeapProfile collects garbage, so that the profile states the heap after the collection, and writes the heap profile of the process to
// heap-<pid>-<ms>.pprof in folder. It returns the path of the file.
func WriteHeapProfile(folder string) (string, error) {
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return "", fmt.Errorf("heap profile folder: %w", err)
	}
	path := filepath.Join(folder, fmt.Sprintf("heap-%d-%d.pprof", os.Getpid(), time.Now().UnixMilli()))
	file, err := os.Create(path)
	if err != nil {
		return "", fmt.Errorf("heap profile: %w", err)
	}
	runtime.GC()
	if err := pprof.WriteHeapProfile(file); err != nil {
		file.Close()
		return "", fmt.Errorf("heap profile %s: %w", path, err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("heap profile %s: %w", path, err)
	}
	return path, nil
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

// SidecarSession is a sidecar session of diagnostics.objects: the sidecar and the surface that sent a request to it.
type SidecarSession struct {
	Sidecar string `json:"sidecar"`
	Surface string `json:"surface"`
}

// Sessions returns the sidecar sessions of the surfaces that owner owns, ordered by sidecar and surface. A surface that sent a request to a
// running sidecar is one session of that sidecar.
func (c *Sidecars) Sessions(owner SidecarOwner) []SidecarSession {
	c.mu.Lock()
	defer c.mu.Unlock()
	sessions := []SidecarSession{}
	for name, process := range c.running {
		for surface := range process.surfaces {
			if c.owners[surface] == owner {
				sessions = append(sessions, SidecarSession{Sidecar: name, Surface: surface})
			}
		}
	}
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].Sidecar != sessions[j].Sidecar {
			return sessions[i].Sidecar < sessions[j].Sidecar
		}
		return sessions[i].Surface < sessions[j].Surface
	})
	return sessions
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
