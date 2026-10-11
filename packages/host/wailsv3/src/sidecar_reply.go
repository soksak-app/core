package host

// The replies of a sidecar (docs/spec/logging.md#entrances): the host stores the event `host.sidecar.reply` when it relays a message
// of a sidecar that names the correlation identifiers of a request (`cids` of the message line) or states an error, and when the
// failure of a sidecar ends the requests that it did not answer. The host remembers the time of each request that carries
// identifiers, so the reply states the microseconds since the request was queued.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sync"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

const (
	// pendingRequestLimit bounds the requests that wait for a reply. The oldest request is forgotten when the bound is reached and the
	// loss is counted as `host.buffer.dropped`; the request is still stored as `host.sidecar.request`, and only the microseconds of its
	// reply, which the two events derive, are lost.
	pendingRequestLimit = 4096
	// failedRequestCids bounds the identifiers that the failed reply of one surface lists: the newest requests.
	failedRequestCids = 64
)

type pendingRequest struct {
	sidecar string
	surface string
	mono    uint64
}

// requestLedger remembers the queued requests that carry correlation identifiers until a reply or a failure names them.
type requestLedger struct {
	mu      sync.Mutex
	pending map[string]pendingRequest
	order   []string
}

// add remembers the requests of cids, queued for the surface of the sidecar at the monotonic time mono, and returns how many
// remembered requests it forgot to stay within the bound; the caller counts them (`host.buffer.dropped`).
func (l *requestLedger) add(sidecar, surface string, cids []string, mono uint64) (forgotten int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.pending == nil {
		l.pending = map[string]pendingRequest{}
	}
	for _, cid := range cids {
		if _, known := l.pending[cid]; known {
			continue
		}
		// An answered request leaves its identifier in the order until the order is compacted, so the order is cut back to the
		// identifiers that still wait whenever it holds twice the bound.
		if len(l.order) >= 2*pendingRequestLimit {
			live := l.order[:0]
			for _, queued := range l.order {
				if _, waiting := l.pending[queued]; waiting {
					live = append(live, queued)
				}
			}
			l.order = live
		}
		for len(l.pending) >= pendingRequestLimit && len(l.order) > 0 {
			oldest := l.order[0]
			l.order = l.order[1:]
			if _, waiting := l.pending[oldest]; waiting {
				delete(l.pending, oldest)
				forgotten++
			}
		}
		l.pending[cid] = pendingRequest{sidecar: sidecar, surface: surface, mono: mono}
		l.order = append(l.order, cid)
	}
	return forgotten
}

// take removes the requests of cids and returns the nanoseconds since the first of them that was remembered, or false when none was.
func (l *requestLedger) take(cids []string, now uint64) (uint64, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var elapsed uint64
	found := false
	for _, cid := range cids {
		request, known := l.pending[cid]
		if !known {
			continue
		}
		if !found {
			elapsed, found = now-request.mono, true
		}
		delete(l.pending, cid)
	}
	return elapsed, found
}

// failed removes the requests that wait for the sidecar and returns their identifiers by surface, the newest failedRequestCids of each
// surface, in the order of the requests, with the surfaces in the order of their oldest request.
func (l *requestLedger) failed(sidecar string) ([]string, map[string][]string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var surfaces []string
	byCid := map[string][]string{}
	kept := l.order[:0]
	for _, cid := range l.order {
		request, known := l.pending[cid]
		if !known {
			continue
		}
		if request.sidecar != sidecar {
			kept = append(kept, cid)
			continue
		}
		if _, listed := byCid[request.surface]; !listed {
			surfaces = append(surfaces, request.surface)
		}
		byCid[request.surface] = append(byCid[request.surface], cid)
		delete(l.pending, cid)
	}
	l.order = kept
	for surface, cids := range byCid {
		if len(cids) > failedRequestCids {
			byCid[surface] = cids[len(cids)-failedRequestCids:]
		}
	}
	return surfaces, byCid
}

// forget removes the requests that wait for the sidecar without an event: the host ended the sidecar, which `host.sidecar.exit` states.
func (l *requestLedger) forget(sidecar string) {
	l.failed(sidecar)
}

// errorOfBody returns the text of the member `error` of a reply body, which a sidecar writes as a string or as another JSON value, and
// whether the body has one. A body without the member, or that is not an object, is not an error reply.
func errorOfBody(body json.RawMessage) (string, bool) {
	if !bytes.Contains(body, []byte(`"error"`)) {
		return "", false
	}
	var object struct {
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &object); err != nil || len(object.Error) == 0 || string(object.Error) == "null" {
		// silent: a body that is not an object, or whose error is null, states no error.
		return "", false
	}
	var text string
	if err := json.Unmarshal(object.Error, &text); err == nil {
		return text, true
	}
	return string(object.Error), true
}

// recordReply stores `host.sidecar.reply` for a message of the sidecar to the surface, when it names the correlation identifiers cids of
// requests or its body states an error.
func (c *Sidecars) recordReply(sidecar, surface string, cids []string, body json.RawMessage) {
	failure, failed := errorOfBody(body)
	if len(cids) == 0 && !failed {
		return
	}
	if err := sok.CheckCids(cids); err != nil {
		LogError("sidecar "+sidecar, fmt.Sprintf("the cids of a reply of surface %s are refused: %v", surface, err))
		cids = nil
	}
	fields := map[string]any{"name": sidecar, "surface": surface, "bytes": len(body), "ok": !failed}
	if elapsed, known := c.requests.take(cids, monotonicNanos()); known {
		fields["micros"] = elapsed / 1000
	}
	level := LevelInfo
	if failed {
		level = LevelWarn
		// silent: the text of an error is cut to 1,024 bytes after its code, and the event has no field that states the cut.
		text, _ := sok.CutText(fmt.Sprintf("%d: %s", codeInternal, failure), CallTextBytes)
		fields["error"] = text
	}
	if len(cids) == 0 {
		EmitHost(level, "host.sidecar.reply", fields)
		return
	}
	EmitHostCids(level, "host.sidecar.reply", cids, fields)
}

// failRequests stores `host.sidecar.reply` as a failure for each surface of the sidecar that has requests waiting, with their
// identifiers and the reason that the failure of the sidecar gives the page.
func (c *Sidecars) failRequests(sidecar, reason string) {
	surfaces, byCid := c.requests.failed(sidecar)
	// silent: the reason is cut to 1,024 bytes after its code, and the event has no field that states the cut.
	text, _ := sok.CutText(fmt.Sprintf("%d: %s", codeInternal, reason), CallTextBytes)
	for _, surface := range surfaces {
		EmitHostCids(LevelWarn, "host.sidecar.reply", byCid[surface], map[string]any{
			"name": sidecar, "surface": surface, "bytes": 0, "ok": false, "error": text,
		})
	}
}
