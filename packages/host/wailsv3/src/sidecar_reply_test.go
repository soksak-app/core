package host

import (
	"fmt"
	"strings"
	"testing"
)

func cidsOf(prefix string, from, to int) []string {
	cids := make([]string, 0, to-from)
	for n := from; n < to; n++ {
		cids = append(cids, fmt.Sprintf("%s.%d", prefix, n))
	}
	return cids
}

// A request that was answered leaves the ledger, and its place in the order of the requests too: the order holds at most twice the
// bound of the pending requests however many requests were answered.
// contract: buffers.sidecar-replies.order-is-bounded
func TestAnsweredRequestsDoNotGrowTheOrderOfTheLedger(t *testing.T) {
	var ledger requestLedger
	for n := 0; n < 5*pendingRequestLimit; n++ {
		cid := fmt.Sprintf("p.%d", n)
		ledger.add("sidecar-a", "tab-1", []string{cid}, uint64(n+1))
		if _, found := ledger.take([]string{cid}, uint64(n+2)); !found {
			t.Fatalf("the request %s was not remembered", cid)
		}
	}
	if got := len(ledger.order); got > 2*pendingRequestLimit {
		t.Fatalf("the order of the ledger holds %d identifiers after all requests were answered, want at most %d", got, 2*pendingRequestLimit)
	}
}

// A request that is forgotten at the bound is counted, so the loss of its microseconds is not silent.
// contract: buffers.sidecar-replies.forgotten-request-is-counted
func TestForgettingARequestAtTheBoundIsCounted(t *testing.T) {
	var ledger requestLedger
	if got := ledger.add("sidecar-a", "tab-1", cidsOf("p", 0, pendingRequestLimit), 1); got != 0 {
		t.Fatalf("%d requests were forgotten below the bound", got)
	}
	if got := ledger.add("sidecar-a", "tab-1", cidsOf("q", 0, 5), 2); got != 5 {
		t.Fatalf("%d requests were counted as forgotten, want 5", got)
	}
	if _, found := ledger.take([]string{"p.0"}, 3); found {
		t.Fatal("the oldest request is still remembered")
	}
}

// contract: sidecars.stop.records-open-requests
// A request with correlation identifiers that is open when the host stops or detaches its sidecar gets a host.sidecar.reply error
// record that names its surface, its sidecar and its identifiers.
func TestAnOpenRequestAtAHostStopGetsAnErrorRecord(t *testing.T) {
	isolateTraceRecords(t)
	c := &Sidecars{}
	c.requests.add("probe-sidecar", "probe-surface", []string{"req-1"}, monotonicNanos())
	c.failStoppedRequests("probe-sidecar")
	got := bufferedTraces(t, "host.sidecar.reply")
	if len(got) != 1 || got[0]["name"] != "probe-sidecar" || got[0]["surface"] != "probe-surface" || got[0]["ok"] != false {
		t.Fatalf("host.sidecar.reply records after the stop: %v, want one error for probe-sidecar and probe-surface", got)
	}
}

// contract: sidecars.start.refuses-zero-hello-timeout
// A Sidecars value that was not built by NewSidecars has no hello timeout. A zero timeout would fail every persistent service at once,
// so the start of a persistent service refuses the value with a named error before it spawns anything.
func TestAZeroHelloTimeoutIsRefusedBeforeAServiceStarts(t *testing.T) {
	c := &Sidecars{}
	_, err := c.processPersistent("probe-service", nil)
	if err == nil || !strings.Contains(err.Error(), "HelloTimeout is not set") {
		t.Fatalf("a persistent start with a zero HelloTimeout returned %v, want an error that names HelloTimeout is not set", err)
	}
}
