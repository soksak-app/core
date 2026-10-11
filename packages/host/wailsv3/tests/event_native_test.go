// The pull of the native ring (docs/spec/logging.md#writers): the writer of the host takes the records of the native
// library at its batch interval, stores them in the layer `native` with the time the library gave, and counts the records
// it refuses and the events the ring refused.
package host_test

import (
	"encoding/binary"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// nativeRecord is a record as the native library drains it: a 4-byte length, then the wall clock (8 bytes), the monotonic
// clock (8 bytes), the level (1 byte), the length of the name (1 byte), the length of the cids (2 bytes), the name, the cids
// (a list separated by commas) and the fields, in the byte order of the host.
func nativeRecord(ts, mono uint64, level byte, cids, name, fields string) []byte {
	body := make([]byte, 20, 20+len(name)+len(cids)+len(fields))
	binary.NativeEndian.PutUint64(body, ts)
	binary.NativeEndian.PutUint64(body[8:], mono)
	body[16] = level
	body[17] = byte(len(name))
	binary.NativeEndian.PutUint16(body[18:], uint16(len(cids)))
	body = append(body, name...)
	body = append(body, cids...)
	body = append(body, fields...)
	record := make([]byte, 4, 4+len(body))
	binary.NativeEndian.PutUint32(record, uint32(len(body)))
	return append(record, body...)
}

// fakeRing hands out its bytes once, as the drain of the native ring does, and holds the loss it reports once.
type fakeRing struct {
	mu          sync.Mutex
	bytes       []byte
	lossEvents  uint64
	lossBytes   uint64
	drainCalled int
}

func (r *fakeRing) pull(buffer []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.drainCalled++
	n := copy(buffer, r.bytes)
	r.bytes = r.bytes[n:]
	return n, nil
}

func (r *fakeRing) loss() (uint64, uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	events, bytes := r.lossEvents, r.lossBytes
	r.lossEvents, r.lossBytes = 0, 0
	return events, bytes
}

func startWithRing(t *testing.T, ring *fakeRing) *host.EventLog {
	t.Helper()
	options := eventLogOptions(t.TempDir())
	options.Pull = ring.pull
	options.PullLoss = ring.loss
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	return log
}

// contract: log.native.stores-pulled-records-in-the-layer-native
func TestTheWriterStoresPulledNativeRecordsInTheLayerNative(t *testing.T) {
	ring := &fakeRing{bytes: append(nativeRecord(1_791_000_000_000_001, 5_000_000_001, 1, "", "native.test.first", `{"index":1}`),
		nativeRecord(1_791_000_000_000_002, 5_000_000_002, 0, "", "native.test.second", `{}`)...)}
	log := startWithRing(t, ring)
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 3 || events[1]["event"] != "native.test.first" || events[2]["event"] != "native.test.second" {
		t.Fatalf("events %v", events)
	}
	first := events[1]
	if first["layer"] != "native" || first["ts_us"] != float64(1_791_000_000_000_001) || first["mono_ns"] != float64(5_000_000_001) || first["level"] != "warn" ||
		first["seq"] != float64(2) || first["fields"].(map[string]any)["index"] != float64(1) || events[2]["level"] != "error" {
		t.Fatalf("pulled event %v", first)
	}
}

// contract: log.native.stores-clock-and-cids-of-pulled-records
func TestAPulledNativeRecordKeepsItsMonotonicClockAndItsCorrelationIdentifiers(t *testing.T) {
	ring := &fakeRing{bytes: append(nativeRecord(1_791_000_000_000_010, 7_000_000_010, 2, "b1.4,b1.5", "native.test.input", `{"keyCode":36}`),
		nativeRecord(1_791_000_000_000_011, 7_000_000_011, 2, "", "native.test.plain", `{}`)...)}
	log := startWithRing(t, ring)
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 3 {
		t.Fatalf("events %v", events)
	}
	input, plain := events[1], events[2]
	cids, ok := input["cids"].([]any)
	if input["mono_ns"] != float64(7_000_000_010) || !ok || len(cids) != 2 || cids[0] != "b1.4" || cids[1] != "b1.5" || input["fields"].(map[string]any)["keyCode"] != float64(36) {
		t.Fatalf("the input record: %v", input)
	}
	if _, present := plain["cids"]; present || plain["mono_ns"] != float64(7_000_000_011) {
		t.Fatalf("the record without identifiers: %v", plain)
	}
}

// contract: log.native.counts-refused-records-and-ring-loss
func TestARefusedNativeRecordAndTheLossOfTheRingAreCountedAsDropped(t *testing.T) {
	good := nativeRecord(1_791_000_000_000_001, 5_000_000_001, 2, "", "native.test.ok", `{}`)
	forged := nativeRecord(1_791_000_000_000_002, 5_000_000_002, 2, "", "host.test.forged", `{}`)
	badFields := nativeRecord(1_791_000_000_000_003, 5_000_000_003, 2, "", "native.test.fields", `{broken`)
	badLevel := nativeRecord(1_791_000_000_000_004, 5_000_000_004, 9, "", "native.test.level", `{}`)
	badCid := nativeRecord(1_791_000_000_000_006, 5_000_000_006, 2, `b1.1,a"b`, "native.test.cid", `{}`)
	emptyCid := nativeRecord(1_791_000_000_000_007, 5_000_000_007, 2, "b1.1,,b1.2", "native.test.empty", `{}`)
	noClock := nativeRecord(1_791_000_000_000_008, 0, 2, "", "native.test.clock", `{}`)
	truncated := append([]byte{}, nativeRecord(1_791_000_000_000_005, 5_000_000_005, 2, "", "native.test.cut", `{"a":1}`)...)
	binary.NativeEndian.PutUint32(truncated, 500)
	ring := &fakeRing{bytes: append(append(append(append(append(append(append(good, forged...), badFields...), badLevel...), badCid...), emptyCid...), noClock...), truncated...), lossEvents: 3, lossBytes: 120}
	log := startWithRing(t, ring)
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	stored, reasons := 0, map[string]float64{}
	for _, event := range readEventLog(t, log.Path()) {
		switch event["event"] {
		case "native.test.ok":
			stored++
		case "log.dropped":
			fields := event["fields"].(map[string]any)
			reasons[fields["reason"].(string)] += fields["count"].(float64)
		}
	}
	if stored != 1 || reasons["the native ring was full"] != 3 || reasons["a native record was refused"] != 7 {
		t.Fatalf("stored %d, dropped %v", stored, reasons)
	}
}

// contract: log.native.pulls-at-the-batch-interval
func TestTheWriterPullsNativeRecordsAtTheBatchInterval(t *testing.T) {
	ring := &fakeRing{}
	options := eventLogOptions(t.TempDir())
	options.BatchInterval = 10 * time.Millisecond
	options.Pull = ring.pull
	options.PullLoss = ring.loss
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	// The ring is empty at the start; a record that arrives later is stored without a flush request.
	time.Sleep(30 * time.Millisecond)
	ring.mu.Lock()
	ring.bytes = nativeRecord(1_791_000_000_000_001, 5_000_000_001, 2, "", "native.test.late", `{}`)
	ring.mu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, event := range readEventLog(t, log.Path()) {
			if event["event"] == "native.test.late" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("the record was not stored within 5 seconds")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
