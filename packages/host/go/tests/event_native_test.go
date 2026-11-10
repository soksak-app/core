// The pull of the native ring (docs/spec/logging.md#writers): the writer of the host takes the records of the native
// library when the ring wakes it and at its batch interval, stores them in the layer `native` with the time the library gave, and counts the records
// it refuses and the events the ring refused.
package host_test

import (
	"encoding/binary"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// nativeRecord is a record of the class call as the native library drains it; the names of the tests that use it are not in the catalog.
func nativeRecord(ts, mono uint64, level byte, cids, name, fields string) []byte {
	return nativeRecordOfClass(ts, mono, level, 2, cids, name, fields)
}

// nativeRecordOfClass is a record as the native library drains it: a 4-byte length, then the wall clock (8 bytes), the monotonic
// clock (8 bytes), the level (1 byte), the class (1 byte), the length of the name (1 byte), the length of the cids (2 bytes), the
// name, the cids (a list separated by commas) and the fields, in the byte order of the host.
func nativeRecordOfClass(ts, mono uint64, level, class byte, cids, name, fields string) []byte {
	body := make([]byte, 21, 21+len(name)+len(cids)+len(fields))
	binary.NativeEndian.PutUint64(body, ts)
	binary.NativeEndian.PutUint64(body[8:], mono)
	body[16] = level
	body[17] = class
	body[18] = byte(len(name))
	binary.NativeEndian.PutUint16(body[19:], uint16(len(cids)))
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
	debugEvents uint64
	debugBytes  uint64
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

// loss returns the loss of a channel once: lossEvents and lossBytes are the channel other, debugEvents and debugBytes the channel debug.
func (r *fakeRing) loss(channel host.Channel) (uint64, uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if channel == host.ChannelDebug {
		events, bytes := r.debugEvents, r.debugBytes
		r.debugEvents, r.debugBytes = 0, 0
		return events, bytes
	}
	events, bytes := r.lossEvents, r.lossBytes
	r.lossEvents, r.lossBytes = 0, 0
	return events, bytes
}

// startWithRing starts a writer with the policy of every level. The ring holds what it holds when the policy is stored, so
// the records follow log.policy in the file.
func startWithRing(t *testing.T, ring *fakeRing) *host.EventLog {
	t.Helper()
	options := support.EventLogOptions(t.TempDir())
	options.Pull = ring.pull
	options.PullLoss = ring.loss
	options.Wake = make(chan struct{})
	ring.mu.Lock()
	held := fakeRing{bytes: ring.bytes, lossEvents: ring.lossEvents, lossBytes: ring.lossBytes, debugEvents: ring.debugEvents, debugBytes: ring.debugBytes}
	ring.bytes, ring.lossEvents, ring.lossBytes, ring.debugEvents, ring.debugBytes = nil, 0, 0, 0, 0
	ring.mu.Unlock()
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	ring.mu.Lock()
	ring.bytes, ring.lossEvents, ring.lossBytes, ring.debugEvents, ring.debugBytes = held.bytes, held.lossEvents, held.lossBytes, held.debugEvents, held.debugBytes
	ring.mu.Unlock()
	return log
}

// noInterval does not end during a test, so what a test finds in the file was not written at the end of an interval.
const noInterval = time.Hour

// stores reports whether the file of the log holds the event.
func stores(t *testing.T, log *host.EventLog, name string) bool {
	t.Helper()
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == name {
			return true
		}
	}
	return false
}

// wakingLog is a writer with a ring, the channel that wakes it and the events of its sleeps and its writes.
type wakingLog struct {
	*host.EventLog
	wake chan struct{}
	// sleeps receives each sleep of the writer; writes receives each batch it wrote.
	sleeps chan bool
	writes chan struct{}
}

// waitFor waits for the writes of the writer until one of them stored the event. It takes the write that stored it, so a count
// of the writes that follow starts after it.
func (w *wakingLog) waitFor(t *testing.T, name string) {
	t.Helper()
	for {
		<-w.writes
		if stores(t, w.EventLog, name) {
			return
		}
	}
}

// startWaking starts a writer with the ring and returns it once it took what its start left and slept. Only an event, a wake,
// a loss, a request or the report of a held count wakes a writer that sleeps, so what follows is what the test does.
func startWaking(t *testing.T, ring *fakeRing, interval time.Duration) *wakingLog {
	t.Helper()
	options := support.EventLogOptions(t.TempDir())
	options.BatchInterval = interval
	options.Pull = ring.pull
	options.PullLoss = ring.loss
	wake := make(chan struct{}, 1)
	options.Wake = wake
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.Close)
	w := &wakingLog{EventLog: log, wake: wake, sleeps: make(chan bool, 64), writes: make(chan struct{}, 64)}
	log.SetOnSleep(func(countHeld bool) {
		select {
		case w.sleeps <- countHeld:
		default:
			t.Error("the test did not take the sleeps of the writer")
		}
	})
	w.slept(t)
	log.SetOnWrite(func(string, int64) {
		select {
		case w.writes <- struct{}{}:
		default:
			t.Error("the test did not take the writes of the writer")
		}
	})
	return w
}

// slept waits for the next sleep of the writer.
func (w *wakingLog) slept(t *testing.T) {
	t.Helper()
	<-w.sleeps
}

// contract: log.native.stores-pulled-records-in-the-layer-native
func TestTheWriterStoresPulledNativeRecordsInTheLayerNative(t *testing.T) {
	ring := &fakeRing{bytes: append(nativeRecord(1_791_000_000_000_001, 5_000_000_001, 1, "", "native.test.first", `{"index":1}`),
		nativeRecord(1_791_000_000_000_002, 5_000_000_002, 0, "", "native.test.second", `{}`)...)}
	log := startWithRing(t, ring)
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 4 || events[2]["event"] != "native.test.first" || events[3]["event"] != "native.test.second" {
		t.Fatalf("events %v", events)
	}
	first := events[2]
	if first["layer"] != "native" || first["ts_us"] != float64(1_791_000_000_000_001) || first["mono_ns"] != float64(5_000_000_001) || first["level"] != "warn" ||
		first["seq"] != float64(3) || first["fields"].(map[string]any)["index"] != float64(1) || events[3]["level"] != "error" {
		t.Fatalf("pulled event %v", first)
	}
}

// contract: log.native.stores-clock-and-cids-of-pulled-records
func TestAPulledNativeRecordKeepsItsMonotonicClockAndItsCorrelationIdentifiers(t *testing.T) {
	ring := &fakeRing{bytes: append(nativeRecord(1_791_000_000_000_010, 7_000_000_010, 2, "b1.4,b1.5", "native.test.input", `{"keyCode":36}`),
		nativeRecord(1_791_000_000_000_011, 7_000_000_011, 2, "", "native.test.plain", `{}`)...)}
	log := startWithRing(t, ring)
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 4 {
		t.Fatalf("events %v", events)
	}
	input, plain := events[2], events[3]
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
	badClass := nativeRecordOfClass(1_791_000_000_000_009, 5_000_000_009, 2, 9, "", "native.test.class", `{}`)
	// A declared event whose record gives another class than the catalog is a defect of the producer and is refused.
	wrongClass := nativeRecordOfClass(1_791_000_000_000_010, 5_000_000_010, 2, 0, "", "native.input.source_changed", `{}`)
	ring := &fakeRing{bytes: append(append(append(append(append(append(append(append(append(good, forged...), badFields...), badLevel...), badCid...), emptyCid...), noClock...), badClass...), wrongClass...), truncated...),
		lossEvents: 3, lossBytes: 120, debugEvents: 2, debugBytes: 40}
	log := startWithRing(t, ring)
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	stored, reasons, channels := 0, map[string]float64{}, map[string]float64{}
	for _, event := range readEventLog(t, log.Path()) {
		switch event["event"] {
		case "native.test.ok":
			stored++
		case "log.dropped":
			fields := event["fields"].(map[string]any)
			reasons[fields["reason"].(string)] += fields["count"].(float64)
			channels[fields["reason"].(string)+"/"+fields["channel"].(string)] += fields["count"].(float64)
		}
	}
	if stored != 1 || reasons["the native ring was full"] != 5 || reasons["a native record was refused"] != 9 {
		t.Fatalf("stored %d, dropped %v", stored, reasons)
	}
	// The loss of the ring names the channel of the refused events; a record that cannot be decoded has no level and is counted in other.
	if channels["the native ring was full/other"] != 3 || channels["the native ring was full/debug"] != 2 || channels["a native record was refused/other"] != 9 {
		t.Fatalf("dropped by channel %v", channels)
	}
}

// contract: log.native.stores-the-class-of-a-pulled-record
func TestAPulledNativeRecordOfADeclaredEventStoresTheCatalogClassAndAnUndeclaredOneStoresNone(t *testing.T) {
	ring := &fakeRing{bytes: append(nativeRecordOfClass(1_791_000_000_000_001, 5_000_000_001, 2, 1, "", "native.input.source_changed", `{}`),
		nativeRecordOfClass(1_791_000_000_000_002, 5_000_000_002, 2, 1, "", "native.test.surprise", `{}`)...)}
	log := startWithRing(t, ring)
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 4 || events[2]["class"] != "input" || events[2]["undeclared"] != nil {
		t.Fatalf("the declared record: %v", events)
	}
	if events[3]["undeclared"] != true || events[3]["class"] != nil {
		t.Fatalf("the undeclared record: %v", events[3])
	}
}

// contract: log.native.wake-stores-a-record-at-once
func TestAWakeOfTheRingStoresItsRecordAtOnce(t *testing.T) {
	ring := &fakeRing{}
	log := startWaking(t, ring, noInterval)
	ring.mu.Lock()
	ring.bytes = nativeRecord(1_791_000_000_000_001, 5_000_000_001, 2, "", "native.test.late", `{}`)
	ring.mu.Unlock()
	log.wake <- struct{}{}
	log.waitFor(t, "native.test.late")
}

// contract: log.native.close-stores-the-ring
func TestCloseStoresTheRecordsOfTheRingWithoutAWake(t *testing.T) {
	ring := &fakeRing{}
	log := startWaking(t, ring, noInterval)
	ring.mu.Lock()
	ring.bytes = nativeRecord(1_791_000_000_000_001, 5_000_000_001, 2, "", "native.test.late", `{}`)
	ring.mu.Unlock()
	log.Close()
	if !stores(t, log.EventLog, "native.test.late") {
		t.Fatal("Close did not store the record of the ring")
	}
}

// The start takes the ring once and sleeps, and a wake takes it at once and at the end of the interval it starts, after which
// the writer sleeps again.
// contract: log.writer.sleeps-with-nothing-to-write
func TestAWriterWithNothingToWriteDoesNotPull(t *testing.T) {
	ring := &fakeRing{}
	log := startWaking(t, ring, 5*time.Millisecond)
	drains := func() int {
		ring.mu.Lock()
		defer ring.mu.Unlock()
		return ring.drainCalled
	}
	if pulled := drains(); pulled != 1 {
		t.Fatalf("the writer pulled %d times before it slept, want the one of its start", pulled)
	}
	log.wake <- struct{}{}
	log.slept(t)
	if pulled := drains() - 1; pulled != 2 {
		t.Fatalf("the writer pulled %d times after one wake, want at once and at the end of the interval", pulled)
	}
}

// The close is the one write after the first event, and the writer writes before the close returns.
// contract: log.writer.stores-the-first-event-at-once
func TestAWriterThatSleptStoresTheFirstEventAtOnceAndGathersTheNext(t *testing.T) {
	log := startWaking(t, &fakeRing{}, noInterval)
	if !log.Emit(host.LevelInfo, "host.test.first", map[string]any{}) {
		t.Fatal("the first event was refused")
	}
	log.waitFor(t, "host.test.first")
	if len(log.writes) != 0 {
		t.Fatal("the first event was written twice")
	}
	for _, name := range []string{"host.test.second", "host.test.third"} {
		if !log.Emit(host.LevelInfo, name, map[string]any{}) {
			t.Fatalf("%s was refused", name)
		}
	}
	log.Close()
	if writes := len(log.writes); writes != 1 {
		t.Fatalf("the writer made %d writes for the two events of an interval and the close, want the one of the close", writes)
	}
	if !stores(t, log.EventLog, "host.test.second") || !stores(t, log.EventLog, "host.test.third") {
		t.Fatal("Close did not store the batch")
	}
}
