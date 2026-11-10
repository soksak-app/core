// The bounds of the buffers of the host (docs/spec/logging.md#bounds): each buffer holds at most a stated number of messages
// and bytes, a message beyond the bound is refused with an error, and the loss is the event `host.buffer.dropped`.
package host_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// A relayed request has no time limit, so the relay keeps no expired requests; the requests that the end of their document
// ended are the ones it remembers for their late replies, at most 256 of them.
// contract: buffers.relay-expired.bounded-and-counted
func TestTheRelayRemembersAtMost256EndedRequestsAndCountsTheOnesItForgets(t *testing.T) {
	log := support.UseRoomyEventLog(t)
	relay := host.NewRelay[string]()
	for i := 0; i < 256+5; i++ {
		result := relay.Request("doc", func(uint64) error {
			relay.Abandon(func(target string) bool { return target == "doc" })
			return nil
		})
		if result.Error == nil || result.Error.Code != 1003 {
			t.Fatalf("a request whose document closed answered %+v, want 1003", result)
		}
	}
	drops := support.BufferDrops(t, log)
	if len(drops) != 5 {
		t.Fatalf("%d events host.buffer.dropped, want 5: %v", len(drops), drops)
	}
	for _, drop := range drops {
		if drop["buffer"] != "relay ended requests" || drop["count"] != float64(1) || drop["bytes"] != float64(0) || drop["reason"] != "the buffer holds 256 requests" {
			t.Fatalf("drop %v", drop)
		}
	}
	// The five oldest are forgotten, so a late reply to the first request has no matching request; the newest is still
	// remembered, and its late reply is an observation.
	if err := relay.Resolve(1, "doc", host.ExposureResult{}); err == nil || err.Error() != "exposure reply 1 has no matching request" {
		t.Fatalf("late reply to a forgotten request: %v", err)
	}
	if err := relay.Resolve(261, "doc", host.ExposureResult{}); err != nil {
		t.Fatalf("late reply to a remembered request: %v, want it accepted as an observation", err)
	}
}

// contract: log.writer.event-over-size-bound-is-cut
func TestAnEventOverTheSizeBoundIsStoredCutWithItsOriginalSize(t *testing.T) {
	log := support.UseRoomyEventLog(t)
	// The text reaches the writer whole, as the fields of a relayed event do; a producer that serializes a value stops at the
	// bound before it (bounds.producer.fields-are-cut-while-serialized).
	oversize, err := json.Marshal(map[string]any{"text": strings.Repeat("é", 3<<20)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := log.EmitRelayed(host.RelayedEvent{TsMicros: time.Now().UnixMicro(), MonoNs: 1, Layer: "host", Level: host.LevelInfo, Event: "host.test.oversize", Fields: oversize}); err != nil {
		t.Fatal(err)
	}
	host.EmitHost(host.LevelInfo, "host.test.small", map[string]any{"text": "kept"})
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	var big, small map[string]any
	for _, event := range events {
		switch event["event"] {
		case "host.test.oversize":
			big = event
		case "host.test.small":
			small = event
		}
	}
	if big == nil || small == nil {
		t.Fatalf("events %v", events)
	}
	original := float64(len(`{"text":"`) + 2*(3<<20) + len(`"}`))
	head := big["fields"].(map[string]any)["head"].(string)
	if big["truncated"] != original || len(head) > host.EventHeadBytes || len(head) < host.EventHeadBytes-3 || !strings.HasPrefix(head, `{"text":"é`) || len(big["fields"].(map[string]any)) != 1 {
		t.Fatalf("truncated %v (want %v), head of %d bytes %.20q", big["truncated"], original, len(head), head)
	}
	if _, has := small["truncated"]; has || small["fields"].(map[string]any)["text"] != "kept" {
		t.Fatalf("the event under the bound changed: %v", small)
	}
	if small["seq"].(float64) != big["seq"].(float64)+1 {
		t.Fatalf("seq %v then %v", big["seq"], small["seq"])
	}
}

// contract: sidecars.write.wait-is-recorded
func TestALineThatIsWrittenAtOnceStoresNoWriteWait(t *testing.T) {
	log := support.UseRoomyEventLog(t)
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte("#!/bin/sh\nexec cat > /dev/null\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(support.Declare(directory, `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	owner := support.NewFakeOwner("/p")
	for i := 0; i < 10; i++ {
		if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	sidecars.Stop()
	if waits := support.WriteWaits(t, log); len(waits) != 0 {
		t.Fatalf("lines written at once stored write waits: %v", waits)
	}
}
