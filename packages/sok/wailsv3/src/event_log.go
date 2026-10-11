package sok

// The event writer of the hosts and of the tool (docs/spec/logging.md#writers).
//
// A producer pushes an event to a queue bounded by count and by bytes without waiting. One writer goroutine assigns seq,
// serializes the JSON line, writes batches, rotates the file when it has a bound, and records the events that the queue
// refused as log.dropped. The hosts and the tool start this writer with their own layer, role, clock and goroutine entrance;
// a process with a source of events that cannot call into the writer (the native ring of a host) gives the writer a Pull.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// EventLogSchema is the schema number of the lines that this writer writes. Schema 2 adds `mono_ns` to every line.
const EventLogSchema = 2

// CheckCids refuses a list of correlation identifiers that the line of an event cannot carry: an identifier is not empty and
// holds no quote, no backslash and no control character, so a native record and a line write it without escaping.
func CheckCids(cids []string) error {
	for _, cid := range cids {
		if cid == "" {
			return fmt.Errorf("a cid is empty")
		}
		for _, c := range cid {
			if c < 0x20 || c == 0x7f || c == '"' || c == '\\' {
				return fmt.Errorf("the cid %q holds a quote, a backslash or a control character", cid)
			}
		}
	}
	return nil
}

// Level is the level of an event.
type Level string

// The levels of an event.
const (
	LevelError Level = "error"
	LevelWarn  Level = "warn"
	LevelInfo  Level = "info"
	LevelDebug Level = "debug"
	LevelTrace Level = "trace"
)

// EventLogOptions say how a writer is started.
type EventLogOptions struct {
	// Directory is the logs folder.
	Directory string
	// Role is the role of the process.
	Role string
	// Boot is the identifier of this run.
	Boot string
	// Layer is the layer of the events that the writer and the process itself produce (`host`, `sok`).
	Layer string
	// Clock reads the monotonic clock of the records (docs/spec/logging.md#event). A clock that cannot be read is reported by
	// the clock itself and stores 0, which the audit of the contract refuses.
	Clock func() uint64
	// Spawn starts the goroutine of the writer through the entrance of the process, which recovers a panic.
	Spawn func(name string, fn func())
	// QueueEvents is the bound of the queue in events.
	QueueEvents int
	// QueueBytes is the bound of the queue in bytes of serialized fields.
	QueueBytes int
	// BatchInterval is how long the writer waits for more events before it writes a batch.
	BatchInterval time.Duration
	// RotateBytes is the size at which the writer starts a new file; the file that was full becomes generation 1. It is 0 for
	// a writer that does not rotate, which then has no Generations.
	RotateBytes int64
	// Generations is the number of earlier files that are kept (`.1` is the newest); the oldest one is removed.
	Generations int
	// Pull takes the events of a source that cannot call into the writer. It runs on the goroutine of the writer at the batch
	// interval and when it flushes: it passes each event to accept, and each loss of the source (events, bytes and the reason)
	// to lost. It is nil when the process has no such source.
	Pull func(accept func(RelayedEvent), lost func(events, bytes uint64, reason string))
}

// pendingEvent is one event waiting for the writer. seq is assigned when the writer serializes it.
type pendingEvent struct {
	tsMicros int64
	// monoNs is the monotonic clock at the occurrence.
	monoNs uint64
	// cids are the correlation identifiers of the inputs the event belongs to.
	cids  []string
	layer string
	level Level
	event string
	// fields is the fields as JSON text, serialized once by the producer.
	fields json.RawMessage
	bytes  int
	// truncated is the size in bytes of the fields text before it was cut to its head, and 0 for an event that was not cut.
	truncated int
	// placed, when set, receives the seq of the line once the writer gave it one, and is closed when the line cannot be written.
	placed chan uint64
}

// eventMessage is what the queue carries: an event, or a request of the owner. Two slots of the queue are reserved for
// requests, so a flush or a stop is never refused because events filled the queue.
type eventMessage struct {
	event *pendingEvent
	flush chan struct{}
	stop  bool
}

// reservedForRequests is the number of slots of the queue that only requests use.
const reservedForRequests = 2

// EventLog is the writer of one process.
type EventLog struct {
	messages     chan eventMessage
	queuedEvents atomic.Int64
	queuedBytes  atomic.Int64
	queueEvents  int64
	queueBytes   int64
	lostEvents   atomic.Uint64
	lostBytes    atomic.Uint64
	path         string
	boot         string
	rotateBytes  int64
	generations  int
	openFields   json.RawMessage
	layer        string
	clock        func() uint64
	pull         func(accept func(RelayedEvent), lost func(events, bytes uint64, reason string))
	done         chan struct{}
	closeOnce    sync.Once
	onWrite      atomic.Pointer[func(path string, size int64)]
}

// SetOnWrite sets the observer that the writer calls after it wrote a batch, with the path of the file and its size. It is
// called on the goroutine of the writer, so it must not wait.
func (l *EventLog) SetOnWrite(observer func(path string, size int64)) {
	l.onWrite.Store(&observer)
}

// StartEventLog creates the folder (mode 0700) and the file (mode 0600, created new), writes log.open and starts the writer.
func StartEventLog(options EventLogOptions) (*EventLog, error) {
	if options.Layer == "" || options.Clock == nil || options.Spawn == nil {
		return nil, fmt.Errorf("event writer: Layer, Clock and Spawn must be set")
	}
	if options.RotateBytes < 0 || options.Generations < 0 || (options.RotateBytes == 0) != (options.Generations == 0) {
		return nil, fmt.Errorf("event writer: RotateBytes %d and Generations %d must both be positive, or both be 0 for a writer that does not rotate",
			options.RotateBytes, options.Generations)
	}
	if err := os.MkdirAll(options.Directory, 0o700); err != nil {
		return nil, err
	}
	// A folder that existed before keeps its mode; the log folder of the contract is private.
	if err := os.Chmod(options.Directory, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(options.Directory, fmt.Sprintf("%s-%s.jsonl", options.Role, options.Boot))
	// os.OpenFile opens the file close-on-exec, so a child process does not inherit it.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	fields, err := json.Marshal(map[string]any{
		"schema": EventLogSchema, "pid": os.Getpid(), "role": options.Role, "boot": options.Boot,
	})
	if err != nil {
		return nil, err
	}
	log := &EventLog{
		messages:    make(chan eventMessage, options.QueueEvents+reservedForRequests),
		queueEvents: int64(options.QueueEvents),
		queueBytes:  int64(options.QueueBytes),
		path:        path,
		boot:        options.Boot,
		rotateBytes: options.RotateBytes,
		generations: options.Generations,
		openFields:  fields,
		layer:       options.Layer,
		clock:       options.Clock,
		pull:        options.Pull,
		done:        make(chan struct{}),
	}
	open := &pendingEvent{tsMicros: time.Now().UnixMicro(), monoNs: log.clock(), layer: log.layer, level: LevelInfo, event: "log.open", fields: fields}
	options.Spawn("event-log-writer", func() { log.write(file, options.BatchInterval, open) })
	return log, nil
}

// CountLoss adds events and bytes that a producer of this process refused before they reached the writer; the writer
// records them as a log.dropped.
func (l *EventLog) CountLoss(events, bytes uint64) {
	l.lostEvents.Add(events)
	l.lostBytes.Add(bytes)
}

// Boot is the identifier of the run that this writer belongs to; with a seq it names a line of the log.
func (l *EventLog) Boot() string { return l.boot }

// EmitPlaced queues an event of the layer of the writer, waits until it is on disk, at most deadline, and returns its seq. The
// queue refusing the event is an error, so a caller that stores the position never stores a position of a line that does not
// exist.
func (l *EventLog) EmitPlaced(level Level, event string, fields json.RawMessage, deadline time.Duration) (uint64, error) {
	if !json.Valid(fields) {
		return 0, fmt.Errorf("the fields of %s are not JSON", event)
	}
	return l.EmitPlacedBounded(level, event, fields, 0, deadline)
}

// EmitPlacedBounded is EmitPlaced for fields that are JSON, or, when produced is not 0, the first bytes of the text that the
// producer stopped at the bound after it had written produced bytes.
func (l *EventLog) EmitPlacedBounded(level Level, event string, fields []byte, produced int, deadline time.Duration) (uint64, error) {
	placed := make(chan uint64, 1)
	if !l.enqueuePlaced(time.Now().UnixMicro(), l.clock(), l.layer, level, event, nil, fields, produced, placed) {
		return 0, fmt.Errorf("the event writer refused %s because its queue was full", event)
	}
	if err := l.Flush(deadline); err != nil {
		return 0, err
	}
	seq, ok := <-placed
	if !ok {
		return 0, fmt.Errorf("the event writer could not write %s", event)
	}
	return seq, nil
}

// Path is the file of this run.
func (l *EventLog) Path() string { return l.path }

// Emit queues an event of the layer of the writer. It returns false, and counts the loss, when the queue has no room. It
// never waits. The fields are serialized once, and only after the queue is known to have room for another event.
func (l *EventLog) Emit(level Level, event string, fields any) bool {
	return l.EmitCids(level, event, nil, fields)
}

// EmitCids queues an event of the layer of the writer like Emit, with the correlation identifiers of the inputs it belongs
// to. An identifier that a line cannot carry is a defect of the caller: it is reported on the standard error, counted as
// lost, and the event is refused.
func (l *EventLog) EmitCids(level Level, event string, cids []string, fields any) bool {
	switch level {
	case LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace:
	default:
		// A level outside the contract is a defect of the caller; the event is counted as lost and the defect is reported.
		l.countLoss(len(event))
		fmt.Fprintf(os.Stderr, "event writer: %s has the level %q, which the contract does not define\n", event, string(level))
		return false
	}
	if err := CheckCids(cids); err != nil {
		l.countLoss(len(event))
		fmt.Fprintf(os.Stderr, "event writer: the cids of %s are refused: %v\n", event, err)
		return false
	}
	if l.queuedEvents.Load() >= l.queueEvents {
		l.countLoss(len(event))
		return false
	}
	text, produced, err := BoundedMarshal(fields, EventFieldsLimitBytes)
	if err != nil {
		// A value that cannot be serialized is a defect of the caller; it is counted in place of the event.
		l.countLoss(len(event))
		fmt.Fprintf(os.Stderr, "event writer: the fields of %s cannot be serialized: %v\n", event, err)
		return false
	}
	return l.enqueue(time.Now().UnixMicro(), l.clock(), l.layer, level, event, cids, text, produced)
}

// layers are the layers of the event contract that another layer of a process relays (docs/spec/logging.md#event).
var layers = []string{"native", "host", "page", "plugin", "sidecar"}

// RelayedEvent is an event that another layer of this process produced, with the clocks and the layer it carries.
type RelayedEvent struct {
	TsMicros int64
	MonoNs   uint64
	Layer    string
	Level    Level
	Event    string
	Cids     []string
	// Fields is the JSON text of the fields. When Produced is not 0, the producer stopped its serialization at the bound after
	// it had written Produced bytes, and Fields is the first bytes of the text (docs/spec/logging.md#bounds).
	Fields   json.RawMessage
	Produced int
}

// EmitRelayed queues an event that another layer of this process produced. The event name must start with the layer, so
// the name and the layer cannot disagree. It returns an error for a layer outside the contract, a name that does not start
// with it, fields that are not JSON, a monotonic clock of 0 or a cid that a line cannot carry, and false, with the loss
// counted, when the queue has no room.
func (l *EventLog) EmitRelayed(e RelayedEvent) (bool, error) {
	if !slices.Contains(layers, e.Layer) {
		return false, fmt.Errorf("the layer %q of %s is not one of %v", e.Layer, e.Event, layers)
	}
	if !strings.HasPrefix(e.Event, e.Layer+".") {
		return false, fmt.Errorf("the event %q does not start with its layer %q", e.Event, e.Layer)
	}
	if e.Produced == 0 && !json.Valid(e.Fields) {
		return false, fmt.Errorf("the fields of %s are not JSON", e.Event)
	}
	if e.MonoNs == 0 {
		return false, fmt.Errorf("the mono_ns of %s is 0", e.Event)
	}
	if err := CheckCids(e.Cids); err != nil {
		return false, fmt.Errorf("the cids of %s: %w", e.Event, err)
	}
	if l.queuedEvents.Load() >= l.queueEvents {
		l.countLoss(len(e.Event))
		return false, nil
	}
	return l.enqueue(e.TsMicros, e.MonoNs, e.Layer, e.Level, e.Event, e.Cids, e.Fields, e.Produced), nil
}

func (l *EventLog) enqueue(tsMicros int64, monoNs uint64, layer string, level Level, event string, cids []string, text json.RawMessage, produced int) bool {
	return l.enqueuePlaced(tsMicros, monoNs, layer, level, event, cids, text, produced, nil)
}

// enqueuePlaced queues an event. produced is 0 for fields that are JSON, which the writer cuts when they are over the bound,
// and for fields that the producer cut at the bound the number of bytes it had written when it stopped; text is then the first
// bytes of the text.
func (l *EventLog) enqueuePlaced(tsMicros int64, monoNs uint64, layer string, level Level, event string, cids []string, text json.RawMessage, produced int, placed chan uint64) bool {
	var truncated int
	if produced > 0 {
		text, truncated = headFields(text, produced)
	} else {
		text, truncated = capFields(text)
	}
	bytes := len(text) + len(event)
	for _, cid := range cids {
		bytes += len(cid)
	}
	if l.queuedBytes.Load()+int64(bytes) > l.queueBytes {
		l.countLoss(bytes)
		return false
	}
	pending := &pendingEvent{tsMicros: tsMicros, monoNs: monoNs, cids: cids, layer: layer, level: level, event: event, fields: text, bytes: bytes, truncated: truncated, placed: placed}
	l.queuedBytes.Add(int64(bytes))
	l.queuedEvents.Add(1)
	select {
	case l.messages <- eventMessage{event: pending}:
		return true
	default:
		l.queuedBytes.Add(-int64(bytes))
		l.queuedEvents.Add(-1)
		l.countLoss(bytes)
		return false
	}
}

// capFields returns the fields text of an event as the writer stores it. Fields over EventFieldsLimitBytes are replaced by
// `{"head": <the first EventHeadBytes bytes of the text>}`, and the second result is the size of the text before the cut;
// it is 0 for fields under the bound (docs/spec/logging.md#bounds).
func capFields(text json.RawMessage) (json.RawMessage, int) {
	if len(text) <= EventFieldsLimitBytes {
		return text, 0
	}
	return headFields(text, len(text))
}

// headFields returns the fields `{"head": <the first EventHeadBytes bytes of text>}` of an event that was cut, and size, the
// size of the text before the cut or the number of bytes that the producer had written when it stopped.
func headFields(text []byte, size int) (json.RawMessage, int) {
	// silent: the event states the size before the cut in truncated, so the flag of the cut adds nothing.
	head, _ := CutText(text, EventHeadBytes)
	cut, err := json.Marshal(map[string]string{"head": head})
	if err != nil {
		// A string serializes without failure, so this is a defect of the serializer; the event keeps its size and no head.
		fmt.Fprintf(os.Stderr, "event writer: the head of an event over the size bound cannot be serialized: %v\n", err)
		return json.RawMessage(`{}`), size
	}
	return cut, size
}

func (l *EventLog) countLoss(bytes int) {
	l.lostEvents.Add(1)
	l.lostBytes.Add(uint64(bytes))
}

// Flush writes everything that is queued and waits until it is on disk, at most deadline.
func (l *EventLog) Flush(deadline time.Duration) error {
	answer := make(chan struct{})
	// A request has a reserved slot, so this send is not refused by a full queue of events.
	select {
	case l.messages <- eventMessage{flush: answer}:
	default:
		return fmt.Errorf("the event writer did not take the flush request")
	}
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	select {
	case <-answer:
		return nil
	case <-timer.C:
		return fmt.Errorf("the event writer did not flush within %s", deadline)
	}
}

// Close writes everything that is queued and ends the writer.
func (l *EventLog) Close() {
	l.closeOnce.Do(func() {
		select {
		case l.messages <- eventMessage{stop: true}:
			<-l.done
		default:
			fmt.Fprintln(os.Stderr, "event writer: the writer did not take the stop request")
		}
	})
}

// eventRecord is the line of one event with the seq that the writer gives it. The fields are already JSON text, so the
// line is assembled without parsing them again.
type eventRecord struct {
	TsMicros int64           `json:"ts_us"`
	MonoNs   uint64          `json:"mono_ns"`
	Seq      uint64          `json:"seq"`
	Level    Level           `json:"level"`
	Layer    string          `json:"layer"`
	Event    string          `json:"event"`
	Cids     []string        `json:"cids,omitempty"`
	Fields   json.RawMessage `json:"fields"`
	// Truncated is the size in bytes of the fields before they were cut; it is absent for an event that was not cut.
	Truncated int `json:"truncated,omitempty"`
}

func serializeEvent(seq uint64, e *pendingEvent) ([]byte, error) {
	line, err := json.Marshal(eventRecord{TsMicros: e.tsMicros, MonoNs: e.monoNs, Seq: seq, Level: e.level, Layer: e.layer, Event: e.event, Cids: e.cids, Fields: e.fields, Truncated: e.truncated})
	if err != nil {
		return nil, err
	}
	return append(line, '\n'), nil
}

// rotate moves the full file to generation 1 and the older generations one step up, removes the generation beyond the
// kept ones, and opens a new file. It returns the new file and the name of the removed generation (empty when none was
// removed). The index files move with the generations (docs/spec/logging.md#index). When a step fails, the failure is reported and
// the writer keeps the file it has.
func (l *EventLog) rotate(file *os.File) (*os.File, string) {
	var next *os.File
	removed := ""
	err := RotateLogIndexes(l.path, l.generations, func() error {
		var err error
		next, removed, err = l.rotateFiles(file)
		return err
	})
	if next == nil {
		fmt.Fprintf(os.Stderr, "event writer: %v\n", err)
		return file, ""
	}
	if err != nil {
		// The files rotated; only the index of the closed file is not complete, and a query builds it again.
		fmt.Fprintf(os.Stderr, "event writer: the index of the rotated file is not complete: %v\n", err)
	}
	return next, removed
}

// rotateFiles renames the generations and opens the new file; it returns the new file and the name of the removed generation.
func (l *EventLog) rotateFiles(file *os.File) (*os.File, string, error) {
	generation := func(n int) string { return fmt.Sprintf("%s.%d", l.path, n) }
	removed := ""
	if err := os.Remove(generation(l.generations)); err == nil {
		removed = filepath.Base(generation(l.generations))
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, "", fmt.Errorf("rotation could not remove %s: %v", generation(l.generations), err)
	}
	for n := l.generations - 1; n >= 1; n-- {
		if err := os.Rename(generation(n), generation(n+1)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, "", fmt.Errorf("rotation could not move %s: %v", generation(n), err)
		}
	}
	if err := os.Rename(l.path, generation(1)); err != nil {
		return nil, "", fmt.Errorf("rotation could not move %s: %v", l.path, err)
	}
	// The new file is opened before the old one is closed, so a failure leaves the writer with a file to write.
	next, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, "", fmt.Errorf("rotation could not open %s: %v", l.path, err)
	}
	if err := file.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "event writer: rotation could not close the full file: %v\n", err)
	}
	return next, removed, nil
}

func (l *EventLog) write(file *os.File, interval time.Duration, open *pendingEvent) {
	defer close(l.done)
	defer func() {
		if err := file.Close(); err != nil {
			fmt.Fprintf(os.Stderr, "event writer: %v\n", err)
		}
	}()
	var seq uint64
	var batch []byte
	// size is the number of bytes of the current file, written or waiting in the batch.
	var size int64
	flush := func() {
		if len(batch) == 0 {
			return
		}
		// A failed write is reported on the standard error; the writer keeps running for the next batch.
		if _, err := file.Write(batch); err != nil {
			fmt.Fprintf(os.Stderr, "event writer: %v\n", err)
		} else if observer := l.onWrite.Load(); observer != nil {
			(*observer)(file.Name(), size)
		}
		batch = batch[:0]
	}
	appendLine := func(e *pendingEvent) {
		seq++
		line, err := serializeEvent(seq, e)
		if e.placed != nil {
			if err != nil {
				close(e.placed)
			} else {
				e.placed <- seq
			}
		}
		if err != nil {
			// The line is not written; the seq stays taken, so the audit shows the gap next to this report.
			fmt.Fprintf(os.Stderr, "event writer: %s cannot be written: %v\n", e.event, err)
			return
		}
		batch = append(batch, line...)
		size += int64(len(line))
	}
	push := func(e *pendingEvent) {
		// The line is serialized with the next seq. A file that this line would take past the bound is closed first;
		// the new file opens with log.open and the record of the rotation, so every file of the contract starts with
		// log.open and seq continues.
		line, err := serializeEvent(seq+1, e)
		if err == nil && l.rotateBytes > 0 && size > 0 && size+int64(len(line)) > l.rotateBytes {
			flush()
			full := size
			next, removed := l.rotate(file)
			if next != file {
				file = next
				size = 0
				appendLine(&pendingEvent{tsMicros: time.Now().UnixMicro(), monoNs: l.clock(), layer: l.layer, level: LevelInfo, event: "log.open", fields: l.openFields})
				name := "null"
				if removed != "" {
					quoted, err := json.Marshal(removed)
					if err != nil {
						fmt.Fprintf(os.Stderr, "event writer: the removed name cannot be written: %v\n", err)
					} else {
						name = string(quoted)
					}
				}
				appendLine(&pendingEvent{tsMicros: time.Now().UnixMicro(), monoNs: l.clock(), layer: l.layer, level: LevelInfo, event: "log.rotated",
					fields: json.RawMessage(fmt.Sprintf(`{"bytes":%d,"kept":%d,"removed":%s}`, full, l.generations, name))})
			}
			appendLine(e)
			return
		}
		appendLine(e)
	}
	push(open)
	// dropped stores one log.dropped after the range of seq that the refused events would have had.
	dropped := func(events, bytes uint64, reason string) {
		if events == 0 {
			return
		}
		// The refused events had no seq. Their numbers are skipped, and log.dropped is stored after the range that it
		// names (docs/spec/logging.md#event).
		from := seq + 1
		seq += events
		// The fields are numbers and a fixed text, so they are written as text without a serializer that can fail.
		fields := json.RawMessage(fmt.Sprintf(`{"from_seq":%d,"to_seq":%d,"count":%d,"bytes":%d,"reason":%q}`,
			from, seq, events, bytes, reason))
		push(&pendingEvent{tsMicros: time.Now().UnixMicro(), monoNs: l.clock(), layer: l.layer, level: LevelWarn, event: "log.dropped", fields: fields})
	}
	// pull takes the events of the source of the process. No event source reaches the writer from there (a native thread
	// must not call into Go), so the writer pulls at its batch interval and when it flushes.
	pull := func() {
		if l.pull == nil {
			return
		}
		l.pull(func(e RelayedEvent) {
			push(&pendingEvent{tsMicros: e.TsMicros, monoNs: e.MonoNs, cids: e.Cids, layer: e.Layer, level: e.Level, event: e.Event, fields: e.Fields})
		}, dropped)
	}
	recordLoss := func() {
		events := l.lostEvents.Swap(0)
		dropped(events, l.lostBytes.Swap(0), "the queue was full")
	}
	write := flush
	take := func(e *pendingEvent) {
		l.queuedBytes.Add(-int64(e.bytes))
		l.queuedEvents.Add(-1)
		push(e)
	}
	// drain takes every event that is queued now, then the loss counted so far, writes them, and returns the request
	// that it met, if any.
	drain := func() *eventMessage {
		pull()
		for {
			select {
			case message := <-l.messages:
				if message.event != nil {
					take(message.event)
					continue
				}
				recordLoss()
				write()
				return &message
			default:
				recordLoss()
				write()
				return nil
			}
		}
	}
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case message := <-l.messages:
			if message.event != nil {
				urgent := message.event.level == LevelError
				take(message.event)
				if urgent {
					recordLoss()
					write()
				}
				continue
			}
			pull()
			recordLoss()
			write()
			if message.flush != nil {
				close(message.flush)
			}
			if message.stop {
				return
			}
		case <-timer.C:
			if request := drain(); request != nil {
				if request.flush != nil {
					close(request.flush)
				}
				if request.stop {
					return
				}
			}
			timer.Reset(interval)
		}
	}
}
