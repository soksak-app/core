package host

// The records of the host (docs/spec/logging.md#writers): an error or an observation of the host, and a record that the
// page reports, are events `<layer>.record.<level>` with the fields `where` and `text`. A bounded start buffer holds the
// records written before the writer of the host exists.

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// StartBufferRecords is the number of records that the start buffer holds; a record beyond it is refused and counted.
const StartBufferRecords = 1024

type bufferedRecord struct {
	tsMicros int64
	layer    string
	level    Level
	event    string
	fields   json.RawMessage
}

// records guards the writer of the records and the start buffer, so a record written while the writer is attached keeps its
// place in the order.
var records struct {
	sync.Mutex
	log       *EventLog
	buffer    []bufferedRecord
	lostCount uint64
	lostBytes uint64
}

// UseHostEventLog makes log the writer of the records of the host and hands it the records of the start buffer in their
// order and with the time they were written; the records that the buffer refused are counted in the writer. A nil log
// detaches the writer and clears the buffer.
func UseHostEventLog(log *EventLog) {
	records.Lock()
	defer records.Unlock()
	records.log = log
	buffered, lost, lostBytes := records.buffer, records.lostCount, records.lostBytes
	records.buffer, records.lostCount, records.lostBytes = nil, 0, 0
	if log == nil {
		return
	}
	for _, record := range buffered {
		if _, err := log.EmitRelayed(record.tsMicros, record.layer, record.level, record.event, record.fields); err != nil {
			fmt.Fprintf(os.Stderr, "event writer: a buffered record cannot be stored: %v\n", err)
		}
	}
	log.CountLoss(lost, lostBytes)
}

// emitRecord stores an entry as the event `<layer>.record.<level>`.
func emitRecord(e Entry) {
	var level Level
	switch e.Level {
	case "error":
		level = LevelError
	case "info":
		level = LevelInfo
	default:
		fmt.Fprintf(os.Stderr, "event writer: the record %q of %s has the level %q, which is not error or info\n", e.Where, e.Layer, e.Level)
		return
	}
	fields, err := json.Marshal(map[string]string{"where": e.Where, "text": fmt.Sprint(e.Text)})
	if err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the record %q of %s cannot be serialized: %v\n", e.Where, e.Layer, err)
		return
	}
	// events: host.record.<level>, sidecar.record.<level>
	storeEvent(level, e.Layer, e.Layer+".record."+e.Level, e.Where, fields)
}

// storeEvent hands an event to the writer of the host, or to the start buffer while no writer exists. place names the record
// in the reports of a refusal.
func storeEvent(level Level, layer, name, place string, fields json.RawMessage) {
	now := time.Now().UnixMicro()
	records.Lock()
	defer records.Unlock()
	if records.log == nil {
		if len(records.buffer) >= StartBufferRecords {
			records.lostCount++
			records.lostBytes += uint64(len(fields) + len(name))
			return
		}
		records.buffer = append(records.buffer, bufferedRecord{tsMicros: now, layer: layer, level: level, event: name, fields: fields})
		return
	}
	if _, err := records.log.EmitRelayed(now, layer, level, name, fields); err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the record %q of %s cannot be stored: %v\n", place, layer, err)
	}
}

// emitTrace stores an observation of the trace of the host as the event `host.<kind>.<event>`, where kind is `trace` for the
// layer `host` and `sampler` for the layer `sampler`. The fields hold the name of the event in `event`, which the name of the
// stored event replaces.
func emitTrace(layer string, fields map[string]any) error {
	var kind string
	switch layer {
	case "host":
		kind = "trace"
	case "sampler":
		kind = "sampler"
	default:
		return fmt.Errorf("the layer %q of an observation is not host or sampler", layer)
	}
	event, ok := fields["event"].(string)
	if !ok || event == "" {
		return fmt.Errorf("event must be a string")
	}
	rest := make(map[string]any, len(fields))
	for key, value := range fields {
		if key != "event" {
			rest[key] = value
		}
	}
	text, err := json.Marshal(rest)
	if err != nil {
		return fmt.Errorf("the fields of %s cannot be serialized: %w", event, err)
	}
	// events: host.trace.<event>, host.sampler.<event>
	storeEvent(LevelDebug, "host", "host."+kind+"."+event, event, text)
	return nil
}

// EmitHost stores an event of the layer `host` with the level, the name `host.<subsystem>.<event>` and the fields. It is the
// entrance of the sources of the host that are not records (docs/spec/logging.md#automatic-entrances). A name outside
// `host.` and fields that cannot be serialized are reported on the standard error and nothing is stored.
func EmitHost(level Level, event string, fields map[string]any) {
	if !strings.HasPrefix(event, "host.") {
		fmt.Fprintf(os.Stderr, "event writer: the event %q does not start with host.\n", event)
		return
	}
	text, err := json.Marshal(fields)
	if err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the fields of %s cannot be serialized: %v\n", event, err)
		return
	}
	// events: forwarded
	storeEvent(level, "host", event, event, text)
}

// FlushRecords waits until the records written so far are in the event log, at most deadline. The paths that end the process
// call it, so the record of the failure is stored before the process ends. Without an attached writer there is nothing to
// wait for: the records wait in the start buffer, and the standard error holds the failure.
func FlushRecords(deadline time.Duration) error {
	records.Lock()
	log := records.log
	records.Unlock()
	if log == nil {
		return nil
	}
	return log.Flush(deadline)
}

// EmitHostPlaced stores an event of the layer `host` like EmitHost, waits until it is in the event log, and returns the boot
// identifier of the log and the seq of the line, which together name the line. Without an attached writer the event has no
// position, so it is an error.
func EmitHostPlaced(level Level, event string, fields map[string]any, deadline time.Duration) (string, uint64, error) {
	if !strings.HasPrefix(event, "host.") {
		return "", 0, fmt.Errorf("the event %q does not start with host.", event)
	}
	text, err := json.Marshal(fields)
	if err != nil {
		return "", 0, fmt.Errorf("the fields of %s cannot be serialized: %w", event, err)
	}
	records.Lock()
	log := records.log
	records.Unlock()
	if log == nil {
		return "", 0, fmt.Errorf("the event log of the host is not attached")
	}
	seq, err := log.EmitPlaced(level, event, text, deadline)
	if err != nil {
		return "", 0, err
	}
	return log.Boot(), seq, nil
}
