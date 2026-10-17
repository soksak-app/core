// The bounds of the values that the host produces (docs/spec/logging.md#bounds): a producer cuts a value while it
// serializes it, the start buffer and the lists of the endpoint have bounds, and every loss is counted.
package host_test

import (
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// reads counts the elements that the serializer asked for their text.
var reads atomic.Int64

// element is a value of 100 bytes of JSON text that counts each time its text is built.
type element struct{}

func (element) MarshalJSON() ([]byte, error) {
	reads.Add(1)
	return []byte(`"` + strings.Repeat("e", 98) + `"`), nil
}

// storedEvent returns the only event `name` that the writer stored.
func storedEvent(t *testing.T, log *host.EventLog, name string) map[string]any {
	t.Helper()
	if err := log.Flush(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	var found []map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == name {
			found = append(found, event)
		}
	}
	if len(found) != 1 {
		t.Fatalf("%d events %s, want 1: %v", len(found), name, found)
	}
	return found[0]
}

// checkCut checks that the event holds a head of the fields and states that the producer stopped just over the bound.
func checkCut(t *testing.T, event map[string]any) {
	t.Helper()
	fields := event["fields"].(map[string]any)
	head, ok := fields["head"].(string)
	if !ok || len(fields) != 1 || len(head) != host.EventHeadBytes {
		t.Fatalf("fields %v, want only a head of %d bytes", fields, host.EventHeadBytes)
	}
	cut, _ := event["truncated"].(float64)
	if cut <= host.EventFieldsLimitBytes || cut > host.EventFieldsLimitBytes+4096 {
		t.Fatalf("truncated %v, want just over %d: the producer stops at the bound", cut, host.EventFieldsLimitBytes)
	}
}

// contract: bounds.producer.fields-are-cut-while-serialized
func TestTheFieldsOfAHostEventAreCutWhileTheyAreSerialized(t *testing.T) {
	log := useEventLog(t)
	reads.Store(0)
	big := make([]element, 1_000_000)
	host.EmitHost(host.LevelDebug, "host.test.big", map[string]any{"data": big})
	if count := reads.Load(); count > 20_000 {
		t.Fatalf("%d elements were serialized, want about %d", count, host.EventFieldsLimitBytes/100)
	}
	checkCut(t, storedEvent(t, log, "host.test.big"))
}

// contract: bounds.producer.fields-are-cut-while-serialized
func TestTheFieldsOfAnEmittedEventAreCutWhileTheyAreSerialized(t *testing.T) {
	log := useEventLog(t)
	reads.Store(0)
	big := make([]element, 1_000_000)
	if !log.Emit(host.LevelDebug, "host.test.emitted", map[string]any{"data": big}) {
		t.Fatal("the writer refused the event")
	}
	if count := reads.Load(); count > 20_000 {
		t.Fatalf("%d elements were serialized, want about %d", count, host.EventFieldsLimitBytes/100)
	}
	checkCut(t, storedEvent(t, log, "host.test.emitted"))
}

// contract: bounds.producer.fields-are-cut-while-serialized
func TestTheFieldsOfAHostEventThatFitAreStoredAsTheirJSON(t *testing.T) {
	log := useEventLog(t)
	host.EmitHost(host.LevelDebug, "host.test.small", map[string]any{
		"list": []any{1, "x\n\"é", nil, true, 1.5, []string{"a"}}, "inner": map[string]any{"c": "d"}, "none": nil, "count": 7,
	})
	fields := storedEvent(t, log, "host.test.small")["fields"]
	want := map[string]any{
		"list": []any{float64(1), "x\n\"é", nil, true, 1.5, []any{"a"}}, "inner": map[string]any{"c": "d"}, "none": nil, "count": float64(7),
	}
	if !reflect.DeepEqual(fields, want) {
		t.Fatalf("fields %v, want %v", fields, want)
	}
}

// contract: bounds.producer.record-text-is-cut
func TestTheTextAndThePlaceOfARecordAreCutAtTheirBounds(t *testing.T) {
	log := useEventLog(t)
	host.LogError(strings.Repeat("p", 3000), strings.Repeat("é", 10000))
	fields := storedEvent(t, log, "host.record.error")["fields"].(map[string]any)
	text, place := fields["text"].(string), fields["where"].(string)
	if len(text) > 8192 || len(text) < 8190 || len(place) > 1024 || fields["truncated"] != true {
		t.Fatalf("text of %d bytes, place of %d bytes, truncated %v; want at most 8192 and 1024 bytes and true", len(text), len(place), fields["truncated"])
	}
}

// contract: bounds.start-buffer.holds-at-most-four-mebibytes
func TestTheStartBufferHoldsAtMostFourMebibytesAndTheWriterCountsTheRest(t *testing.T) {
	host.UseHostEventLog(nil)
	const records = 1000
	text := strings.Repeat("x", 8000)
	for index := 0; index < records; index++ {
		host.LogInfo("flood", text)
	}
	options := eventLogOptions(t.TempDir())
	options.QueueEvents = 4 * host.StartBufferRecords
	options.QueueBytes = 64 << 20
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	host.UseHostEventLog(log)
	t.Cleanup(func() { host.UseHostEventLog(nil) })
	if err := log.Flush(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	stored, dropped, droppedBytes := 0, float64(0), float64(0)
	for _, event := range readEventLog(t, log.Path()) {
		switch event["event"] {
		case "host.record.info":
			stored++
		case "log.dropped":
			fields := event["fields"].(map[string]any)
			dropped += fields["count"].(float64)
			droppedBytes += fields["bytes"].(float64)
		}
	}
	if stored*len(text) > host.StartBufferBytes || stored < host.StartBufferBytes/len(text)*9/10 || int(dropped) != records-stored || droppedBytes < float64(len(text)) {
		t.Fatalf("stored %d of %d, dropped %v with %v bytes; want at most %d bytes stored and the rest counted", stored, records, dropped, droppedBytes, host.StartBufferBytes)
	}
}

// contract: bounds.endpoint.topic-changes-hold-at-most-256
func TestTheSubscriptionChangesOfATopicHoldAtMost256AndTheRestIsRefusedAndCounted(t *testing.T) {
	log := useEventLog(t)
	backend := newFakeBackend()
	backend.held = make(chan struct{})
	backend.holdMethod = "status.watch"
	backend.entered = make(chan struct{}, 1)
	backend.unwatched = make(chan struct{}, 512)
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	watch := map[string]any{"window": "main", "name": "core.layout"}
	request := func(id int, method string) {
		send(t, conn, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": watch})
	}
	request(1, "status.watch")
	<-backend.entered
	const pending, refused = 256, 10
	for id := 2; id <= 1+pending+refused; id++ {
		request(id, map[bool]string{true: "status.watch", false: "status.unwatch"}[id%2 == 1])
	}
	// The refusals are answered at once and in no fixed order; the accepted changes wait for the page.
	refusedIDs := map[int]bool{}
	for range refused {
		got, err := receive(t, conn)
		if err != nil || got.Error == nil || got.ID == nil || !strings.Contains(got.Error.Message, "256") {
			t.Fatalf("reply %+v (%v), want a refusal", got, err)
		}
		refusedIDs[*got.ID] = true
	}
	for id := 2 + pending; id <= 1+pending+refused; id++ {
		if !refusedIDs[id] {
			t.Fatalf("request %d was not refused: %v", id, refusedIDs)
		}
	}
	close(backend.held)
	for index := range 1 + pending {
		got, err := receive(t, conn)
		if err != nil || got.Error != nil {
			t.Fatalf("reply %d of %d: %+v (%v), want a success", index, 1+pending, got, err)
		}
	}
	if err := log.Flush(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	drops := 0
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] != "host.buffer.dropped" {
			continue
		}
		fields := event["fields"].(map[string]any)
		if fields["buffer"] != "endpoint topic changes" || fields["count"] != float64(1) || fields["reason"] != "the buffer holds 256 messages" {
			t.Fatalf("event %v", event)
		}
		drops++
	}
	if drops != refused {
		t.Fatalf("%d events host.buffer.dropped, want %d", drops, refused)
	}
}

// contract: bounds.endpoint.output-queue-holds-at-most-sixteen-mebibytes
func TestTheOutputQueueOfAConnectionHoldsAtMostSixteenMebibytesAndTheRefusalIsCounted(t *testing.T) {
	log := useEventLog(t)
	endpoint, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	reply := call(t, conn, 1, "status.watch", map[string]any{"window": "main", "name": "core.layout"})
	if reply.Error != nil {
		t.Fatalf("watch failed: %+v", reply.Error)
	}
	// The connection reads nothing, so the frames wait in the output queue until the bound refuses one.
	big := strings.Repeat("x", 1<<20)
	for index := 0; index < 80; index++ {
		endpoint.StatusChanged("main", "core.layout", "", big)
	}
	if err := log.Flush(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] != "host.buffer.dropped" {
			continue
		}
		fields := event["fields"].(map[string]any)
		if fields["buffer"] != "endpoint output queue" || fields["count"] != float64(1) || fields["bytes"].(float64) < 1<<20 || fields["reason"] != "the buffer holds 16777216 bytes" {
			t.Fatalf("event %v", event)
		}
		return
	}
	t.Fatal("no event host.buffer.dropped: the output queue has no byte bound")
}
