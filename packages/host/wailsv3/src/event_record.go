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

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// panicFlushDeadline is how long the entrance of the goroutines waits for the event of a panic to reach the file before the
// process ends.
const panicFlushDeadline = 2 * time.Second

// PanicWriterDeadline is how long the entrance of the goroutines waits for the writer when the panic happened before the writer
// was attached. The writer attaches during the start of the host; the bound ends a process whose start never attaches it.
// The value is 5 seconds; a test injects a shorter one.
var PanicWriterDeadline = 5 * time.Second

// writerAttached is closed when the writer of the host is attached for the first time.
var writerAttached = make(chan struct{})

var writerAttachedOnce sync.Once

func init() {
	routine.Record = recordPanic
}

// recordPanic stores the panic of a goroutine as the event `host.panic` and waits until it is in the event log. A panic before
// the writer is attached waits for the writer, at most panicWriterDeadline, so the event enters the writer and not only the start
// buffer that the process end would drop. A flush that fails is reported on the standard error, which holds the stack as well.
func recordPanic(name, text, stack string) {
	if !waitForWriter(PanicWriterDeadline) {
		// No writer exists to store the record, so the record is written to the standard error in full.
		fmt.Fprintf(os.Stderr, "event writer: the record of the panic is not stored: no writer opened within %s\nhost.panic name=%s text=%s\n%s", PanicWriterDeadline, name, text, stack)
		return
	}
	EmitHost(LevelError, "host.panic", map[string]any{"name": name, "text": text, "stack": stack})
	if err := FlushRecords(panicFlushDeadline); err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the record of the panic of %s is not stored: %v\n", name, err)
	}
}

// waitForWriter waits at most deadline until the writer is attached, and reports whether it is.
func waitForWriter(deadline time.Duration) bool {
	select {
	case <-writerAttached:
		return true
	default:
	}
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	select {
	case <-writerAttached:
		return true
	case <-timer.C:
		return false
	}
}

// StartBufferRecords is the number of records that the start buffer holds; a record beyond it is refused and counted.
const StartBufferRecords = 1024

type bufferedRecord struct {
	tsMicros int64
	monoNs   uint64
	cids     []string
	layer    string
	level    Level
	event    string
	fields   json.RawMessage
	// produced is 0 for fields that are JSON, and for fields that the producer cut at the bound the number of bytes it had
	// written when it stopped; fields is then the first bytes of the text.
	produced int
}

// records guards the writer of the records and the start buffer, so a record written while the writer is attached keeps its
// place in the order.
var records struct {
	sync.Mutex
	log         *EventLog
	buffer      []bufferedRecord
	bufferBytes int
	// lost counts the records that the full buffer refused, for each channel of the writer.
	lost [sok.ChannelCount]struct{ count, bytes uint64 }
}

// EmitClosed stores the event `log.closed` of the host process that ends (docs/spec/logging.md#self-reports). cause is `exit`,
// `exit-request` or `signal`, and signal is the termination signal of the cause `signal`.
func EmitClosed(cause string, signal *int) {
	records.Lock()
	log := records.log
	records.Unlock()
	if log == nil {
		fmt.Fprintf(os.Stderr, "event writer: log.closed (%s) cannot be stored: the writer is not attached\n", cause)
		return
	}
	if !log.RecordClosed(cause, signal) {
		fmt.Fprintf(os.Stderr, "event writer: log.closed (%s) cannot be stored: the queue has no room\n", cause)
	}
}

// UseHostEventLog makes log the writer of the records of the host and hands it the records of the start buffer in their
// order and with the time they were written; the records that the buffer refused are counted in the writer. A nil log
// detaches the writer and clears the buffer.
func UseHostEventLog(log *EventLog) {
	records.Lock()
	defer records.Unlock()
	records.log = log
	activeLog.Store(log)
	if log != nil {
		writerAttachedOnce.Do(func() { close(writerAttached) })
	}
	buffered, lost := records.buffer, records.lost
	records.buffer, records.bufferBytes, records.lost = nil, 0, [sok.ChannelCount]struct{ count, bytes uint64 }{}
	if log == nil {
		return
	}
	for _, record := range buffered {
		if _, err := log.EmitRelayed(RelayedEvent{TsMicros: record.tsMicros, MonoNs: record.monoNs, Layer: record.layer, Level: record.level,
			Event: record.event, Cids: record.cids, Fields: record.fields, Produced: record.produced}); err != nil {
			fmt.Fprintf(os.Stderr, "event writer: a buffered record cannot be stored: %v\n", err)
		}
	}
	for channel := sok.Channel(0); channel < sok.ChannelCount; channel++ {
		log.CountLoss(channel, lost[channel].count, lost[channel].bytes)
	}
}

// emitRecord stores an entry as the event `<layer>.record.<level>`. The place and the text are cut to RecordPlaceBytes and
// RecordTextBytes on a character boundary before they are copied, and the fields say `truncated` when either was cut.
func emitRecord(e Entry) {
	var level Level
	switch e.Level {
	case "error":
		level = LevelError
	case "warn":
		level = LevelWarn
	case "info":
		level = LevelInfo
	default:
		fmt.Fprintf(os.Stderr, "event writer: the record %q of %s has the level %q, which is not error, warn or info\n", e.Where, e.Layer, e.Level)
		return
	}
	var body string
	switch text := e.Text.(type) {
	case string:
		body = text
	default:
		body = fmt.Sprint(e.Text)
	}
	where, cutWhere := sok.CutText(e.Where, RecordPlaceBytes)
	body, cutBody := sok.CutText(body, RecordTextBytes)
	record := map[string]any{"where": where, "text": body}
	if cutWhere || cutBody {
		record["truncated"] = true
	}
	fields, err := json.Marshal(record)
	if err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the record %q of %s cannot be serialized: %v\n", e.Where, e.Layer, err)
		return
	}
	// events: host.record.<level>, sidecar.record.<level>
	storeEvent(level, e.Layer, e.Layer+".record."+e.Level, e.Where, nil, fields, 0)
}

// storeEvent hands an event to the writer of the host, or to the start buffer while no writer exists. place names the record
// in the reports of a refusal.
//
// produced is 0 for fields that are JSON, and for fields that the producer cut at the bound the number of bytes it had
// written when it stopped. The start buffer holds at most StartBufferRecords records and StartBufferBytes bytes; a record
// beyond either is refused and counted in the writer.
func storeEvent(level Level, layer, name, place string, cids []string, fields json.RawMessage, produced int) {
	now := time.Now().UnixMicro()
	mono := monotonicNanos()
	records.Lock()
	defer records.Unlock()
	if records.log == nil {
		size := len(fields) + len(name)
		if len(records.buffer) >= StartBufferRecords || records.bufferBytes+size > StartBufferBytes {
			records.lost[sok.ChannelOf(level)].count++
			records.lost[sok.ChannelOf(level)].bytes += uint64(size)
			return
		}
		records.buffer = append(records.buffer, bufferedRecord{tsMicros: now, monoNs: mono, cids: cids, layer: layer, level: level, event: name, fields: fields, produced: produced})
		records.bufferBytes += size
		return
	}
	if _, err := records.log.EmitRelayed(RelayedEvent{TsMicros: now, MonoNs: mono, Layer: layer, Level: level, Event: name, Cids: cids, Fields: fields, Produced: produced}); err != nil {
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
	text, produced, err := sok.BoundedMarshal(rest, EventFieldsLimitBytes)
	if err != nil {
		return fmt.Errorf("the fields of %s cannot be serialized: %w", event, err)
	}
	// events: host.trace.<event>, host.sampler.<event>
	storeEvent(LevelDebug, "host", "host."+kind+"."+event, event, nil, text, produced)
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
	// A closed gate serializes nothing; an event the catalog does not declare has no class and no gate.
	if class, declared := sok.EventClassOf(event); declared && !sok.PassesEveryGate(event) && !GateEvent(class, level) {
		return
	}
	text, produced, err := sok.BoundedMarshal(fields, EventFieldsLimitBytes)
	if err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the fields of %s cannot be serialized: %v\n", event, err)
		return
	}
	// events: forwarded
	storeEvent(level, "host", event, event, nil, text, produced)
}

// EmitHostCids stores an event of the layer `host` like EmitHost, with the correlation identifiers of the inputs it belongs to
// (docs/spec/logging.md#correlation-identifier). An identifier that a line cannot carry is reported on the standard error
// and nothing is stored.
func EmitHostCids(level Level, event string, cids []string, fields map[string]any) {
	if !strings.HasPrefix(event, "host.") {
		fmt.Fprintf(os.Stderr, "event writer: the event %q does not start with host.\n", event)
		return
	}
	if class, declared := sok.EventClassOf(event); declared && !sok.PassesEveryGate(event) && !GateEvent(class, level) {
		return
	}
	if err := sok.CheckCids(cids); err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the cids of %s are refused: %v\n", event, err)
		return
	}
	text, produced, err := sok.BoundedMarshal(fields, EventFieldsLimitBytes)
	if err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the fields of %s cannot be serialized: %v\n", event, err)
		return
	}
	// events: forwarded
	storeEvent(level, "host", event, event, cids, text, produced)
}

// RecordInputRelay stores the event `host.input.relay` for an image region event that carries correlation identifiers, with
// the surface and the name of the region and the `type` of the event. A region event without identifiers stores nothing. An
// event that is not a JSON object, whose `cids` are not a list of identifiers or whose `type` is not a string is an error
// and stores nothing.
func RecordInputRelay(surface, name, event string) error {
	var body struct {
		Type json.RawMessage `json:"type"`
		Cids json.RawMessage `json:"cids"`
	}
	if err := json.Unmarshal([]byte(event), &body); err != nil {
		return fmt.Errorf("the region event of %s is not a JSON object: %w", surface, err)
	}
	if body.Cids == nil {
		return nil
	}
	var cids []string
	if err := json.Unmarshal(body.Cids, &cids); err != nil {
		return fmt.Errorf("the cids of the region event of %s are not an array of strings: %w", surface, err)
	}
	if len(cids) == 0 {
		return nil
	}
	if err := sok.CheckCids(cids); err != nil {
		return fmt.Errorf("the cids of the region event of %s: %w", surface, err)
	}
	var kind string
	if err := json.Unmarshal(body.Type, &kind); err != nil {
		return fmt.Errorf("the type of the region event of %s must be a string: %w", surface, err)
	}
	EmitHostCids(LevelInfo, "host.input.relay", cids, map[string]any{"surface": surface, "name": name, "type": kind})
	return nil
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
	text, produced, err := sok.BoundedMarshal(fields, EventFieldsLimitBytes)
	if err != nil {
		return "", 0, fmt.Errorf("the fields of %s cannot be serialized: %w", event, err)
	}
	records.Lock()
	log := records.log
	records.Unlock()
	if log == nil {
		return "", 0, fmt.Errorf("the event log of the host is not attached")
	}
	seq, err := log.EmitPlacedBounded(level, event, text, produced, deadline)
	if err != nil {
		return "", 0, err
	}
	return log.Boot(), seq, nil
}
