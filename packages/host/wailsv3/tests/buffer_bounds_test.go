// The bounds of the buffers of the host (docs/spec/logging.md#bounds): each buffer holds at most a stated number of messages
// and bytes, a message beyond the bound is refused with an error, and the loss is the event `host.buffer.dropped`.
package host_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// blockedSidecar starts a sidecar that reads nothing until the returned function releases it, fills its write queue, and
// returns the sidecars with the registered surfaces s1 to s<surfaces>. The owner has the project root `root`.
func blockedSidecar(t *testing.T, root string, surfaces int) (*host.Sidecars, func()) {
	t.Helper()
	directory := t.TempDir()
	fifo := filepath.Join(directory, "go")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	received := filepath.Join(directory, "received")
	script := "#!/bin/sh\nread _ < " + fifo + "\nexec cat > " + received + "\n"
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"echo","protocol":2}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	sidecars.StopTimeout = stall
	owner := newFakeOwner(root)
	for i := 1; i <= surfaces; i++ {
		if err := sidecars.Send(owner, echoSidecar, fmt.Sprintf("s%d", i), json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	// A line larger than the pipe of the sidecar (64 KiB at most on macOS) keeps the writer inside its write, so it takes no more
	// lines from the queue; a surface line of a long root does the same. No event reports the start of a write, so the
	// fixture waits on the state of the writer.
	blocker := json.RawMessage(`{"data":"` + strings.Repeat("b", 2<<20) + `"}`)
	if err := sidecars.Send(owner, echoSidecar, "s1", blocker); err != nil {
		t.Fatal(err)
	}
	for wait := 0; ; wait++ {
		writing, err := sidecars.Writing(echoSidecar)
		if err != nil {
			t.Fatal(err)
		}
		if writing > 64<<10 {
			break
		}
		if wait == 10000 {
			t.Fatalf("the writer did not start the line of %d bytes within 10 s (writing %d)", len(blocker), writing)
		}
		time.Sleep(time.Millisecond)
	}
	big := json.RawMessage(`{"data":"` + strings.Repeat("x", 20*1024) + `"}`)
	full := false
	for i := 0; i < 4000 && !full; i++ {
		if err := sidecars.Send(owner, echoSidecar, "s1", big); err != nil {
			if !strings.Contains(err.Error(), "is not keeping up") {
				t.Fatal(err)
			}
			full = true
		}
	}
	if !full {
		t.Fatal("the queue never filled")
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			file, err := os.OpenFile(fifo, os.O_WRONLY, 0)
			if err != nil {
				t.Error(err)
				return
			}
			file.Write([]byte("go\n"))
			file.Close()
			sidecars.Stop()
		})
	}
	// A test that ends early releases the sidecar too, so Stop does not wait for a process that reads nothing.
	t.Cleanup(release)
	return sidecars, release
}

// useRoomyEventLog is useEventLog with a queue that holds the records of a flood of messages.
func useRoomyEventLog(t *testing.T) *host.EventLog {
	t.Helper()
	host.UseHostEventLog(nil)
	options := eventLogOptions(t.TempDir())
	options.QueueEvents, options.QueueBytes = 1<<16, 64<<20
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	host.UseHostEventLog(log)
	t.Cleanup(func() { host.UseHostEventLog(nil) })
	return log
}

// bufferDrops flushes the writer and returns the fields of the events `host.buffer.dropped`.
func bufferDrops(t *testing.T, log *host.EventLog) []map[string]any {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var drops []map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "host.buffer.dropped" {
			if event["level"] != "warn" || event["layer"] != "host" {
				t.Fatalf("event %v is not a warning of the layer host", event)
			}
			drops = append(drops, event["fields"].(map[string]any))
		}
	}
	return drops
}

func response(name string, padding int) json.RawMessage {
	return json.RawMessage(`{"image":{"consumed":{"name":"` + name + `","pad":"` + strings.Repeat("p", padding) + `"}}}`)
}

// contract: buffers.sidecar-replies.bounded-by-messages
func TestThePendingRepliesOfASidecarHoldAtMostOneThousandAndTwentyFourMessages(t *testing.T) {
	log := useRoomyEventLog(t)
	sidecars, release := blockedSidecar(t, "/p", 1)
	var refused []string
	for i := 0; i < 1024+10; i++ {
		if err := sidecars.SendResponse(echoSidecar, "s1", "a", response("a", 0)); err != nil {
			refused = append(refused, err.Error())
		}
	}
	want := "sidecar " + echoSidecar + ": the pending replies reached 1024 messages, so a reply of surface s1 is dropped"
	if len(refused) != 10 || refused[0] != want {
		t.Fatalf("%d replies refused, first %q; want 10 and %q", len(refused), first(refused), want)
	}
	drops := bufferDrops(t, log)
	if len(drops) != 10 {
		t.Fatalf("%d events host.buffer.dropped, want 10: %v", len(drops), drops)
	}
	for _, drop := range drops {
		if drop["buffer"] != "sidecar "+echoSidecar+" pending replies" || drop["count"] != float64(1) || drop["reason"] != "the buffer holds 1024 messages" || drop["bytes"].(float64) <= 0 {
			t.Fatalf("drop %v", drop)
		}
	}
	release()
}

// contract: buffers.sidecar-replies.bounded-by-bytes
func TestThePendingRepliesOfASidecarHoldAtMostFourMebibytes(t *testing.T) {
	log := useRoomyEventLog(t)
	sidecars, release := blockedSidecar(t, "/p", 1)
	var refused []string
	for i := 0; i < 4; i++ {
		if err := sidecars.SendResponse(echoSidecar, "s1", "a", response("a", 3<<19)); err != nil {
			refused = append(refused, err.Error())
		}
	}
	if len(refused) != 2 || !strings.HasSuffix(refused[0], "the pending replies reached 4194304 bytes, so a reply of surface s1 is dropped") {
		t.Fatalf("refused %q; want two refusals that name 4194304 bytes", refused)
	}
	drops := bufferDrops(t, log)
	if len(drops) != 2 || drops[0]["reason"] != "the buffer holds 4194304 bytes" || drops[0]["count"] != float64(1) || drops[0]["bytes"].(float64) < 3<<19 {
		t.Fatalf("drops %v", drops)
	}
	release()
}

// contract: buffers.sidecar-closes.bounded-and-forgotten
func TestAPendingCloseBeyondTheBoundIsDroppedAndTheSurfaceIsNotWaitedFor(t *testing.T) {
	log := useRoomyEventLog(t)
	// A long project root makes each close message large, so the bound in bytes is reached with few surfaces.
	root := "/" + strings.Repeat("r", 200<<10)
	sidecars, release := blockedSidecar(t, root, 30)
	for i := 1; i <= 30; i++ {
		sidecars.Close(fmt.Sprintf("s%d", i))
	}
	drops := bufferDrops(t, log)
	if len(drops) == 0 {
		t.Fatal("no close was dropped")
	}
	for _, drop := range drops {
		if drop["buffer"] != "sidecar "+echoSidecar+" pending closes" || drop["count"] != float64(1) || drop["reason"] != "the buffer holds 4194304 bytes" {
			t.Fatalf("drop %v", drop)
		}
	}
	// A dropped close is not awaited: the surfaces that wait for a reply are those whose close message was buffered.
	if waiting := len(sidecars.Closing()); waiting != 30-len(drops) {
		t.Fatalf("%d surfaces wait for a reply and %d closes were dropped; want 30 in all", waiting, len(drops))
	}
	release()
}

func first(list []string) string {
	if len(list) == 0 {
		return ""
	}
	return list[0]
}

// contract: buffers.relay-expired.bounded-and-counted
func TestTheRelayRemembersAtMost256ExpiredRequestsAndCountsTheOnesItForgets(t *testing.T) {
	log := useRoomyEventLog(t)
	relay := host.NewRelay[string]()
	for i := 0; i < 256+5; i++ {
		result := relay.Request("doc", time.Millisecond, func(uint64) error { return nil })
		if result.Error == nil {
			t.Fatal("a request without a reply did not time out")
		}
	}
	drops := bufferDrops(t, log)
	if len(drops) != 5 {
		t.Fatalf("%d events host.buffer.dropped, want 5: %v", len(drops), drops)
	}
	for _, drop := range drops {
		if drop["buffer"] != "relay expired requests" || drop["count"] != float64(1) || drop["bytes"] != float64(0) || drop["reason"] != "the buffer holds 256 requests" {
			t.Fatalf("drop %v", drop)
		}
	}
	// The five oldest are forgotten, so a late reply to the first request has no matching request; the newest is still remembered.
	if err := relay.Resolve(1, "doc", host.ExposureResult{}); err == nil || err.Error() != "exposure reply 1 has no matching request" {
		t.Fatalf("late reply to a forgotten request: %v", err)
	}
	if err := relay.Resolve(261, "doc", host.ExposureResult{}); err == nil || !strings.Contains(err.Error(), "its request timed out after 1 ms") {
		t.Fatalf("late reply to a remembered request: %v", err)
	}
}

// contract: log.writer.event-over-size-bound-is-cut
func TestAnEventOverTheSizeBoundIsStoredCutWithItsOriginalSize(t *testing.T) {
	log := useRoomyEventLog(t)
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

// writeWaits flushes the writer and returns the fields of the events `host.sidecar.write_wait`.
func writeWaits(t *testing.T, log *host.EventLog) []map[string]any {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var waits []map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "host.sidecar.write_wait" {
			if event["level"] != "info" || event["layer"] != "host" {
				t.Fatalf("event %v is not an info of the layer host", event)
			}
			waits = append(waits, event["fields"].(map[string]any))
		}
	}
	return waits
}

// contract: sidecars.write.wait-is-recorded
func TestALineThatWaitsInTheWriteQueueOfASidecarIsRecorded(t *testing.T) {
	log := useRoomyEventLog(t)
	_, release := blockedSidecar(t, "/p", 1)
	// The sidecar reads nothing, so the queued lines wait at least this long before the release lets the writer go on.
	time.Sleep(1100 * time.Millisecond)
	release()
	waits := writeWaits(t, log)
	queued, blocked := 0, 0
	for _, wait := range waits {
		if wait["name"] != echoSidecar || wait["bytes"].(float64) <= 0 {
			t.Fatalf("write wait %v does not name %s with the bytes of the line", wait, echoSidecar)
		}
		if wait["queued_us"].(float64) >= 1e6 {
			queued++
		}
		if wait["write_us"].(float64) >= 1e6 {
			blocked++
		}
	}
	if queued == 0 || blocked != 1 {
		t.Fatalf("%d waits of a second in the queue and %d blocked writes, want some and 1: %v", queued, blocked, waits)
	}
}

// contract: sidecars.write.wait-is-recorded
func TestALineThatIsWrittenAtOnceStoresNoWriteWait(t *testing.T) {
	log := useRoomyEventLog(t)
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte("#!/bin/sh\nexec cat > /dev/null\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"echo","protocol":2}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	owner := newFakeOwner("/p")
	for i := 0; i < 10; i++ {
		if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	sidecars.Stop()
	if waits := writeWaits(t, log); len(waits) != 0 {
		t.Fatalf("lines written at once stored write waits: %v", waits)
	}
}
