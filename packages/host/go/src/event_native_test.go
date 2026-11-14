// The records of the native ring as bytes (docs/spec/logging.md#writers): the decoder of the host takes the records that the drain of
// the ring gives, refuses and counts the records it cannot decode, and the writer stores the decoded events in the layer `native`
// with the clocks that the library gave. The scheduling of the pull and the loss of a full ring run against the real ring in
// tests/platform/darwin/system/event_native_test.go.
package host

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	sok "github.com/soksak-app/core/packages/sok/go/src"
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

// concatenated joins records into the buffer of one drain.
func concatenated(records ...[]byte) []byte {
	var buffer []byte
	for _, record := range records {
		buffer = append(buffer, record...)
	}
	return buffer
}

// nativeRefusedCase is a record that the decoder refuses, with a part of its error. located is false for a record whose length is
// wrong: the decoder reports the length 0 for it, so the caller abandons the rest of the buffer.
type nativeRefusedCase struct {
	name    string
	record  []byte
	located bool
	error   string
}

// nativeRefusedCases are the records of the refused forms of docs/spec/logging.md#writers, the record of a bad length last.
func nativeRefusedCases() []nativeRefusedCase {
	truncated := nativeRecord(1_791_000_000_000_005, 5_000_000_005, 2, "", "native.test.cut", `{"a":1}`)
	binary.NativeEndian.PutUint32(truncated, 500)
	return []nativeRefusedCase{
		{"a name that does not start with the layer", nativeRecord(1_791_000_000_000_002, 5_000_000_002, 2, "", "host.test.forged", `{}`), true, `does not start with its layer "native"`},
		{"fields that are not JSON", nativeRecord(1_791_000_000_000_003, 5_000_000_003, 2, "", "native.test.fields", `{broken`), true, "are not a JSON object"},
		{"a level outside the enumeration", nativeRecord(1_791_000_000_000_004, 5_000_000_004, 9, "", "native.test.level", `{}`), true, "the level 9 is not defined"},
		{"a cid with a quote", nativeRecord(1_791_000_000_000_006, 5_000_000_006, 2, `b1.1,a"b`, "native.test.cid", `{}`), true, "the cids of native.test.cid"},
		{"an empty cid", nativeRecord(1_791_000_000_000_007, 5_000_000_007, 2, "b1.1,,b1.2", "native.test.empty", `{}`), true, "the cids of native.test.empty"},
		{"a monotonic clock of 0", nativeRecord(1_791_000_000_000_008, 0, 2, "", "native.test.clock", `{}`), true, "the monotonic clock of native.test.clock is 0"},
		{"a class outside the enumeration", nativeRecordOfClass(1_791_000_000_000_009, 5_000_000_009, 2, 9, "", "native.test.class", `{}`), true, "the class 9 is not defined"},
		// A declared event whose record gives another class than the catalog is a defect of the producer and is refused.
		{"a class that the catalog does not declare for the event", nativeRecordOfClass(1_791_000_000_000_010, 5_000_000_010, 2, 0, "", "native.input.source_changed", `{}`), true, "the catalog declares input"},
		{"a length that the buffer does not hold", truncated, false, "does not fit"},
	}
}

// A refused record reports its own length so the decoder moves to the next record, except a record whose length is wrong, which has
// no length to move by.
// contract: log.native.counts-refused-records-and-ring-loss
func TestTheDecoderRefusesARecordItCannotDecodeWithTheReasonAndItsLength(t *testing.T) {
	for _, c := range nativeRefusedCases() {
		t.Run(c.name, func(t *testing.T) {
			length, _, err := nativeEventOf(c.record)
			if err == nil || !strings.Contains(err.Error(), c.error) {
				t.Fatalf("the record was refused with %v, want an error that holds %q", err, c.error)
			}
			wantLength := 0
			if c.located {
				wantLength = len(c.record)
			}
			if length != wantLength {
				t.Fatalf("the refused record reported the length %d, want %d", length, wantLength)
			}
		})
	}
}

// contract: log.native.counts-refused-records-and-ring-loss
func TestTheRefusedRecordsOfABufferAreCountedInTheChannelOtherAndTheGoodRecordIsStored(t *testing.T) {
	good := nativeRecord(1_791_000_000_000_001, 5_000_000_001, 2, "", "native.test.ok", `{}`)
	cases := nativeRefusedCases()
	// The truncated record is last: nothing after a record whose length is wrong can be located.
	records := [][]byte{good}
	for _, c := range cases {
		records = append(records, c.record)
	}
	buffer := concatenated(records...)
	var accepted []string
	var events, bytes uint64
	var reasons []string
	var channels []Channel
	nativeRecordsOf(buffer, func(event sok.RelayedEvent) { accepted = append(accepted, event.Event) },
		func(lostEvents, lostBytes uint64, reason string, channel Channel) {
			events += lostEvents
			bytes += lostBytes
			reasons = append(reasons, reason)
			channels = append(channels, channel)
		})
	if len(accepted) != 1 || accepted[0] != "native.test.ok" {
		t.Fatalf("accepted %v", accepted)
	}
	if events != uint64(len(cases)) || len(reasons) != 1 || reasons[0] != "a native record was refused" {
		t.Fatalf("lost %d events with the reasons %v, want %d with one reason", events, reasons, len(cases))
	}
	// A record that cannot be decoded has no level and is counted in other.
	if channels[0] != ChannelOther {
		t.Fatalf("the refused records were counted in the channel %v", channels[0])
	}
	// Each refusal counts the bytes from the start of the refused record to the end of the buffer.
	var wantBytes uint64
	offset := len(good)
	for _, c := range cases {
		wantBytes += uint64(len(buffer) - offset)
		offset += len(c.record)
	}
	if bytes != wantBytes {
		t.Fatalf("the refused records counted %d bytes, want %d", bytes, wantBytes)
	}
}

// startNativeTestLog starts a writer that stores every level, with bounds that the tests do not reach.
func startNativeTestLog(t *testing.T) *EventLog {
	t.Helper()
	log, err := StartEventLog(EventLogOptions{
		Directory: t.TempDir(), Role: "host", Boot: "b1", QueueEvents: 64, QueueBytes: 64 * 1024,
		BatchInterval: 20 * time.Millisecond, RotateBytes: 1 << 30, RetentionBytes: 1 << 40,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.Close)
	policy, err := ParseLogPolicy("native test policy", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	return log
}

// storeNativeBuffer gives the records of a drain to the writer as its pull does, and returns the events of the file after the flush.
func storeNativeBuffer(t *testing.T, log *EventLog, buffer []byte) []map[string]any {
	t.Helper()
	nativeRecordsOf(buffer, func(event sok.RelayedEvent) {
		if stored, err := log.EmitRelayed(event); err != nil || !stored {
			t.Fatalf("%s was not stored: %v, %v", event.Event, stored, err)
		}
	}, func(events, bytes uint64, reason string, channel Channel) {
		t.Fatalf("the records of the test lost %d events: %s", events, reason)
	})
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(log.Path())
	if err != nil {
		t.Fatal(err)
	}
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("not JSON: %q: %v", line, err)
		}
		events = append(events, event)
	}
	return events
}

// contract: log.native.stores-pulled-records-in-the-layer-native
func TestTheWriterStoresDecodedNativeRecordsInTheLayerNative(t *testing.T) {
	log := startNativeTestLog(t)
	events := storeNativeBuffer(t, log, concatenated(
		nativeRecord(1_791_000_000_000_001, 5_000_000_001, 1, "", "native.test.first", `{"index":1}`),
		nativeRecord(1_791_000_000_000_002, 5_000_000_002, 0, "", "native.test.second", `{}`)))
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
func TestADecodedNativeRecordKeepsItsMonotonicClockAndItsCorrelationIdentifiers(t *testing.T) {
	log := startNativeTestLog(t)
	events := storeNativeBuffer(t, log, concatenated(
		nativeRecord(1_791_000_000_000_010, 7_000_000_010, 2, "b1.4,b1.5", "native.test.input", `{"keyCode":36}`),
		nativeRecord(1_791_000_000_000_011, 7_000_000_011, 2, "", "native.test.plain", `{}`)))
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

// contract: log.native.stores-the-class-of-a-pulled-record
func TestADecodedNativeRecordOfADeclaredEventStoresTheCatalogClassAndAnUndeclaredOneStoresNone(t *testing.T) {
	log := startNativeTestLog(t)
	events := storeNativeBuffer(t, log, concatenated(
		nativeRecordOfClass(1_791_000_000_000_001, 5_000_000_001, 2, 1, "", "native.input.source_changed", `{}`),
		nativeRecordOfClass(1_791_000_000_000_002, 5_000_000_002, 2, 1, "", "native.test.surprise", `{}`)))
	if len(events) != 4 || events[2]["class"] != "input" || events[2]["undeclared"] != nil {
		t.Fatalf("the declared record: %v", events)
	}
	if events[3]["undeclared"] != true || events[3]["class"] != nil {
		t.Fatalf("the undeclared record: %v", events[3])
	}
}
