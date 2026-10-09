package host

// The event writer of the host (docs/spec/logging.md#writers).
//
// A producer pushes an event to a queue bounded by count and by bytes without waiting. One writer goroutine assigns
// seq, serializes the JSON line, writes batches and records the events that the queue refused as log.dropped.

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
	"syscall"
	"time"
)

// EventLogSchema is the schema number of the lines that this writer writes.
const EventLogSchema = 1

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
	// QueueEvents is the bound of the queue in events.
	QueueEvents int
	// QueueBytes is the bound of the queue in bytes of serialized fields.
	QueueBytes int
	// BatchInterval is how long the writer waits for more events before it writes a batch.
	BatchInterval time.Duration
	// RotateBytes is the size at which the writer starts a new file; the file that was full becomes generation 1.
	RotateBytes int64
	// Generations is the number of earlier files that are kept (`.1` is the newest); the oldest one is removed.
	Generations int
}

// pendingEvent is one event waiting for the writer. seq is assigned when the writer serializes it.
type pendingEvent struct {
	tsMicros int64
	layer    string
	level    Level
	event    string
	// fields is the fields as JSON text, serialized once by the producer.
	fields json.RawMessage
	bytes  int
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
	rotateBytes  int64
	generations  int
	openFields   json.RawMessage
	done         chan struct{}
	closeOnce    sync.Once
}

// StartEventLog creates the folder (mode 0700) and the file (mode 0600), writes log.open and starts the writer.
func StartEventLog(options EventLogOptions) (*EventLog, error) {
	if options.RotateBytes <= 0 {
		return nil, fmt.Errorf("event writer: RotateBytes must be positive, not %d", options.RotateBytes)
	}
	if options.Generations <= 0 {
		return nil, fmt.Errorf("event writer: Generations must be positive, not %d", options.Generations)
	}
	if err := os.MkdirAll(options.Directory, 0o700); err != nil {
		return nil, err
	}
	// A folder that existed before keeps its mode; the log folder of the contract is private.
	if err := os.Chmod(options.Directory, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(options.Directory, fmt.Sprintf("%s-%s.jsonl", options.Role, options.Boot))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY|syscall.O_CLOEXEC, 0o600)
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
		rotateBytes: options.RotateBytes,
		generations: options.Generations,
		openFields:  fields,
		done:        make(chan struct{}),
	}
	open := &pendingEvent{tsMicros: time.Now().UnixMicro(), layer: "host", level: LevelInfo, event: "log.open", fields: fields}
	go log.write(file, options.BatchInterval, open)
	return log, nil
}

// The bounds of the writer of a host: events and bytes of serialized fields waiting for the batch interval.
const (
	hostQueueEvents   = 8192
	hostQueueBytes    = 16 << 20
	hostBatchInterval = 100 * time.Millisecond
	hostRotateBytes   = 100 << 20
	hostGenerations   = 5
)

// StartHostEventLog starts the writer of the host in logs/ of the configuration folder; the boot identifier is the
// start time in seconds and the process identifier.
func StartHostEventLog(config string) (*EventLog, error) {
	return StartEventLog(EventLogOptions{
		Directory: filepath.Join(config, "logs"), Role: "host", Boot: fmt.Sprintf("%d-%d", time.Now().Unix(), os.Getpid()),
		QueueEvents: hostQueueEvents, QueueBytes: hostQueueBytes, BatchInterval: hostBatchInterval,
		RotateBytes: hostRotateBytes, Generations: hostGenerations,
	})
}

// Path is the file that this writer writes.
func (l *EventLog) Path() string { return l.path }

// Emit queues an event. It returns false, and counts the loss, when the queue has no room. It never waits. The fields
// are serialized once, and only after the queue is known to have room for another event.
func (l *EventLog) Emit(level Level, event string, fields any) bool {
	switch level {
	case LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace:
	default:
		// A level outside the contract is a defect of the caller; the event is counted as lost and the defect is reported.
		l.countLoss(len(event))
		fmt.Fprintf(os.Stderr, "event writer: %s has the level %q, which the contract does not define\n", event, string(level))
		return false
	}
	if l.queuedEvents.Load() >= l.queueEvents {
		l.countLoss(len(event))
		return false
	}
	text, err := json.Marshal(fields)
	if err != nil {
		// A value that cannot be serialized is a defect of the caller; it is counted in place of the event.
		l.countLoss(len(event))
		fmt.Fprintf(os.Stderr, "event writer: the fields of %s cannot be serialized: %v\n", event, err)
		return false
	}
	return l.enqueue(time.Now().UnixMicro(), "host", level, event, text)
}

// layers are the layers of the event contract (docs/spec/logging.md#event).
var layers = []string{"native", "host", "page", "plugin", "sidecar"}

// EmitRelayed queues an event that another layer of this process produced, with the time and the layer it carries. The
// event name must start with the layer, so the name and the layer cannot disagree. It returns an error for a layer
// outside the contract, a name that does not start with it, or fields that are not JSON, and false, with the loss
// counted, when the queue has no room.
func (l *EventLog) EmitRelayed(tsMicros int64, layer string, level Level, event string, fields json.RawMessage) (bool, error) {
	if !slices.Contains(layers, layer) {
		return false, fmt.Errorf("the layer %q of %s is not one of %v", layer, event, layers)
	}
	if !strings.HasPrefix(event, layer+".") {
		return false, fmt.Errorf("the event %q does not start with its layer %q", event, layer)
	}
	if !json.Valid(fields) {
		return false, fmt.Errorf("the fields of %s are not JSON", event)
	}
	if l.queuedEvents.Load() >= l.queueEvents {
		l.countLoss(len(event))
		return false, nil
	}
	return l.enqueue(tsMicros, layer, level, event, fields), nil
}

func (l *EventLog) enqueue(tsMicros int64, layer string, level Level, event string, text json.RawMessage) bool {
	bytes := len(text) + len(event)
	if l.queuedBytes.Load()+int64(bytes) > l.queueBytes {
		l.countLoss(bytes)
		return false
	}
	pending := &pendingEvent{tsMicros: tsMicros, layer: layer, level: level, event: event, fields: text, bytes: bytes}
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
		}
	})
}

// eventRecord is the line of one event with the seq that the writer gives it. The fields are already JSON text, so the
// line is assembled without parsing them again.
type eventRecord struct {
	TsMicros int64           `json:"ts_us"`
	Seq      uint64          `json:"seq"`
	Level    Level           `json:"level"`
	Layer    string          `json:"layer"`
	Event    string          `json:"event"`
	Fields   json.RawMessage `json:"fields"`
}

func eventLine(seq uint64, e *pendingEvent) ([]byte, error) {
	line, err := json.Marshal(eventRecord{TsMicros: e.tsMicros, Seq: seq, Level: e.level, Layer: e.layer, Event: e.event, Fields: e.fields})
	if err != nil {
		return nil, err
	}
	return append(line, '\n'), nil
}

// rotate moves the full file to generation 1 and the older generations one step up, removes the generation beyond the
// kept ones, and opens a new file. It returns the new file and the name of the removed generation (empty when none was
// removed). When a step fails, the failure is reported and the writer keeps the file it has.
func (l *EventLog) rotate(file *os.File) (*os.File, string) {
	generation := func(n int) string { return fmt.Sprintf("%s.%d", l.path, n) }
	removed := ""
	if err := os.Remove(generation(l.generations)); err == nil {
		removed = filepath.Base(generation(l.generations))
	} else if !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "event writer: rotation could not remove %s: %v\n", generation(l.generations), err)
		return file, ""
	}
	for n := l.generations - 1; n >= 1; n-- {
		if err := os.Rename(generation(n), generation(n+1)); err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "event writer: rotation could not move %s: %v\n", generation(n), err)
			return file, ""
		}
	}
	if err := os.Rename(l.path, generation(1)); err != nil {
		fmt.Fprintf(os.Stderr, "event writer: rotation could not move %s: %v\n", l.path, err)
		return file, ""
	}
	// The new file is opened before the old one is closed, so a failure leaves the writer with a file to write.
	next, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		fmt.Fprintf(os.Stderr, "event writer: rotation could not open %s: %v\n", l.path, err)
		return file, ""
	}
	if err := file.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "event writer: rotation could not close the full file: %v\n", err)
	}
	return next, removed
}

func (l *EventLog) write(file *os.File, interval time.Duration, open *pendingEvent) {
	defer close(l.done)
	defer func() { file.Close() }()
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
		}
		batch = batch[:0]
	}
	appendLine := func(e *pendingEvent) {
		seq++
		line, err := eventLine(seq, e)
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
		line, err := eventLine(seq+1, e)
		if err == nil && size > 0 && size+int64(len(line)) > l.rotateBytes {
			flush()
			full := size
			next, removed := l.rotate(file)
			if next != file {
				file = next
				size = 0
				appendLine(&pendingEvent{tsMicros: time.Now().UnixMicro(), layer: "host", level: LevelInfo, event: "log.open", fields: l.openFields})
				name := "null"
				if removed != "" {
					quoted, err := json.Marshal(removed)
					if err != nil {
						fmt.Fprintf(os.Stderr, "event writer: the removed name cannot be written: %v\n", err)
					} else {
						name = string(quoted)
					}
				}
				appendLine(&pendingEvent{tsMicros: time.Now().UnixMicro(), layer: "host", level: LevelInfo, event: "log.rotated",
					fields: json.RawMessage(fmt.Sprintf(`{"bytes":%d,"kept":%d,"removed":%s}`, full, l.generations, name))})
			}
			appendLine(e)
			return
		}
		appendLine(e)
	}
	push(open)
	recordLoss := func() {
		events := l.lostEvents.Swap(0)
		if events == 0 {
			return
		}
		bytes := l.lostBytes.Swap(0)
		// The refused events had no seq. Their numbers are skipped, and log.dropped is stored after the range that it
		// names (docs/spec/logging.md#event).
		from := seq + 1
		seq += events
		// The fields are numbers and a fixed text, so they are written as text without a serializer that can fail.
		fields := json.RawMessage(fmt.Sprintf(`{"from_seq":%d,"to_seq":%d,"count":%d,"bytes":%d,"reason":"the queue was full"}`,
			from, seq, events, bytes))
		push(&pendingEvent{tsMicros: time.Now().UnixMicro(), layer: "host", level: LevelWarn, event: "log.dropped", fields: fields})
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
