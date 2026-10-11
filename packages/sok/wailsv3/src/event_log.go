package sok

// The event writer of the tool (docs/spec/logging.md#writers).
//
// A producer pushes an event to a queue bounded by count and by bytes without waiting. One writer goroutine assigns seq,
// serializes the JSON line, writes batches and records the events that the queue refused as log.dropped. A run of the tool
// emits at most a handful of events (log.open, sok.command, sok.panic), so the file is not rotated.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

// EventLogSchema is the schema number of the lines that this writer writes. Schema 2 adds `mono_ns` to every line.
const EventLogSchema = 2

// The layer and the role of the tool in the event contract.
const (
	eventLayer = "sok"
	eventRole  = "sok"
)

// The bounds of the writer of the tool (docs/spec/logging.md#bounds): events and bytes of serialized fields waiting for the
// batch interval, the size of the fields of one event, and the head that an event over that size keeps.
const (
	eventQueueEvents   = 1024
	eventQueueBytes    = 1 << 20
	eventBatchInterval = 100 * time.Millisecond
	eventFieldsLimit   = 1 << 20
	eventHeadBytes     = 4096
)

// monotonicNanos reads the monotonic clock of the records (docs/spec/logging.md#event). A clock that cannot be read is a
// defect of the platform: it is reported on the standard error (once, because every later event repeats it) and the event
// stores 0, which the audit of the contract refuses.
func monotonicNanos() uint64 {
	system, err := platform.Current()
	if err == nil {
		var nanos uint64
		if nanos, err = system.MonotonicNanos(); err == nil {
			return nanos
		}
	}
	clockFailure.Do(func() { fmt.Fprintf(os.Stderr, "event writer: the monotonic clock cannot be read: %v\n", err) })
	return 0
}

var clockFailure sync.Once

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

// pendingEvent is one event waiting for the writer. seq is assigned when the writer serializes it.
type pendingEvent struct {
	tsMicros int64
	monoNs   uint64
	level    Level
	event    string
	// class is the class that the catalog declares for the event; it is empty, and undeclared is set, for a name the catalog does not declare.
	class      Class
	undeclared bool
	// fields is the fields as JSON text, serialized once by the producer.
	fields json.RawMessage
	bytes  int
	// truncated is the size in bytes of the fields text before it was cut to its head, and 0 for an event that was not cut.
	truncated int
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

// EventLog is the writer of one run of the tool.
type EventLog struct {
	messages     chan eventMessage
	queuedEvents atomic.Int64
	queuedBytes  atomic.Int64
	// lost counts what the queue refused, for each channel.
	lost      [channelCount]struct{ events, bytes atomic.Uint64 }
	path      string
	debugPath string
	// openFields are the fields of log.open, which the first line of every file holds.
	openFields json.RawMessage
	boot       string
	done       chan struct{}
	closeOnce  sync.Once
}

// processBoot is the identifier of this run: the start time in seconds and the process identifier.
func processBoot() string {
	return fmt.Sprintf("%d-%d", time.Now().Unix(), os.Getpid())
}

// StartEventLog creates the folder (mode 0700) and the file logs/sok-<boot>.jsonl (mode 0600, created new), writes
// log.open and starts the writer. config is the configuration directory.
func StartEventLog(config string) (*EventLog, error) {
	directory := filepath.Join(config, "logs")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	// A folder that existed before keeps its mode; the log folder of the contract is private.
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, err
	}
	boot := processBoot()
	path := filepath.Join(directory, fmt.Sprintf("%s-%s.jsonl", eventRole, boot))
	// os.OpenFile opens the file close-on-exec, so a child process does not inherit it.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	fields, err := json.Marshal(map[string]any{"schema": EventLogSchema, "pid": os.Getpid(), "role": eventRole, "boot": boot})
	if err != nil {
		return nil, err
	}
	log := &EventLog{
		messages:   make(chan eventMessage, eventQueueEvents+reservedForRequests),
		path:       path,
		debugPath:  filepath.Join(directory, fmt.Sprintf("%s-%s.debug.jsonl", eventRole, boot)),
		openFields: fields,
		boot:       boot,
		done:       make(chan struct{}),
	}
	open := writerEvent(LevelInfo, "log.open", fields)
	Go("event-log-writer", func() { log.write(file, open) })
	return log, nil
}

// Path is the main file of this run (error, warn and info); the debug file (debug and trace) lies beside it and exists once its
// first event was written.
func (l *EventLog) Path() string { return l.path }

// Boot is the identifier of the run that this writer belongs to.
func (l *EventLog) Boot() string { return l.boot }

// Emit queues an event. It returns false, and counts the loss, when the queue has no room. It never waits. The fields are
// serialized once, and only after the queue is known to have room for another event.
func (l *EventLog) Emit(level Level, event string, fields any) bool {
	switch level {
	case LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace:
	default:
		// A level outside the contract is a defect of the caller; the event is counted as lost and the defect is reported.
		l.countLoss(channelOf(level), len(event))
		fmt.Fprintf(os.Stderr, "event writer: %s has the level %q, which the contract does not define\n", event, string(level))
		return false
	}
	if l.queuedEvents.Load() >= eventQueueEvents {
		l.countLoss(channelOf(level), len(event))
		return false
	}
	text, err := json.Marshal(fields)
	if err != nil {
		// A value that cannot be serialized is a defect of the caller; it is counted in place of the event.
		l.countLoss(channelOf(level), len(event))
		fmt.Fprintf(os.Stderr, "event writer: the fields of %s cannot be serialized: %v\n", event, err)
		return false
	}
	text, truncated := capFields(text)
	bytes := len(text) + len(event)
	if l.queuedBytes.Load()+int64(bytes) > eventQueueBytes {
		l.countLoss(channelOf(level), bytes)
		return false
	}
	pending := &pendingEvent{tsMicros: time.Now().UnixMicro(), monoNs: monotonicNanos(), level: level, event: event, fields: text, bytes: bytes, truncated: truncated}
	pending.classify()
	l.queuedBytes.Add(int64(bytes))
	l.queuedEvents.Add(1)
	select {
	case l.messages <- eventMessage{event: pending}:
		return true
	default:
		l.queuedBytes.Add(-int64(bytes))
		l.queuedEvents.Add(-1)
		l.countLoss(channelOf(level), bytes)
		return false
	}
}

// cutText returns text cut to at most limit bytes on a character boundary, and whether it was cut.
func cutText(text string, limit int) (string, bool) {
	if len(text) <= limit {
		return text, false
	}
	end := limit
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end], true
}

// capFields returns the fields text of an event as the writer stores it. Fields over eventFieldsLimit are replaced by
// `{"head": <the first eventHeadBytes bytes of the text>}`, and the second result is the size of the text before the cut;
// it is 0 for fields under the bound (docs/spec/logging.md#bounds).
func capFields(text json.RawMessage) (json.RawMessage, int) {
	if len(text) <= eventFieldsLimit {
		return text, 0
	}
	// silent: the text is over the bound here, so the second result (whether it was cut) is true by the condition above.
	head, _ := cutText(string(text), eventHeadBytes)
	cut, err := json.Marshal(map[string]string{"head": head})
	if err != nil {
		// A string serializes without failure, so this is a defect of the serializer; the event keeps its size and no head.
		fmt.Fprintf(os.Stderr, "event writer: the head of an event over the size bound cannot be serialized: %v\n", err)
		return json.RawMessage(`{}`), len(text)
	}
	return cut, len(text)
}

func (l *EventLog) countLoss(c channel, bytes int) {
	l.lost[c].events.Add(1)
	l.lost[c].bytes.Add(uint64(bytes))
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

// classify gives the event the class that the catalog declares for its name. A name that the catalog does not declare is stored
// without a class and marked undeclared (docs/spec/logging.md#event).
func (e *pendingEvent) classify() {
	e.class, e.undeclared = "", false
	if class, declared := EventClassOf(e.event); declared {
		e.class = class
	} else {
		e.undeclared = true
	}
}

// writerEvent is an event that the writer itself creates (log.open, log.dropped), with both clocks read now.
func writerEvent(level Level, event string, fields json.RawMessage) *pendingEvent {
	e := &pendingEvent{tsMicros: time.Now().UnixMicro(), monoNs: monotonicNanos(), level: level, event: event, fields: fields}
	e.classify()
	return e
}

// eventRecord is the line of one event with the seq that the writer gives it. The fields are already JSON text, so the
// line is assembled without parsing them again.
type eventRecord struct {
	TsMicros int64           `json:"ts_us"`
	MonoNs   uint64          `json:"mono_ns"`
	Seq      uint64          `json:"seq"`
	Level    Level           `json:"level"`
	Class    Class           `json:"class,omitempty"`
	Layer    string          `json:"layer"`
	Event    string          `json:"event"`
	Fields   json.RawMessage `json:"fields"`
	// Undeclared is true for an event whose name the catalog does not declare; such a line has no class.
	Undeclared bool `json:"undeclared,omitempty"`
	// Truncated is the size in bytes of the fields before they were cut; it is absent for an event that was not cut.
	Truncated int `json:"truncated,omitempty"`
}

func serializeEvent(seq uint64, e *pendingEvent) ([]byte, error) {
	line, err := json.Marshal(eventRecord{TsMicros: e.tsMicros, MonoNs: e.monoNs, Seq: seq, Level: e.level, Class: e.class, Layer: eventLayer, Event: e.event, Fields: e.fields, Undeclared: e.undeclared, Truncated: e.truncated})
	if err != nil {
		return nil, err
	}
	return append(line, '\n'), nil
}

// channel is the file of the writer that stores a level: the main file holds error, warn and info, and the debug file holds debug
// and trace (docs/spec/logging.md#files).
type channel int

const (
	channelMain channel = iota
	channelDebug
	channelCount
)

// name is the name of the channel in log.dropped: `other` for the main file and `debug` for the debug file.
func (c channel) name() string {
	if c == channelDebug {
		return "debug"
	}
	return "other"
}

func channelOf(level Level) channel {
	if level == LevelDebug || level == LevelTrace {
		return channelDebug
	}
	return channelMain
}

// outputFile is one file of the writer. The debug file is created when its first line is written, so a run without a debug event
// leaves no empty file.
type outputFile struct {
	path  string
	file  *os.File
	batch []byte
}

func (l *EventLog) write(main *os.File, open *pendingEvent) {
	defer close(l.done)
	files := [channelCount]*outputFile{channelMain: {path: l.path, file: main}, channelDebug: {path: l.debugPath}}
	defer func() {
		for _, f := range files {
			if f.file == nil {
				continue
			}
			if err := f.file.Close(); err != nil {
				fmt.Fprintf(os.Stderr, "event writer: %v\n", err)
			}
		}
	}()
	var seq uint64
	flush := func() {
		for _, f := range files {
			if len(f.batch) == 0 {
				continue
			}
			// A failed write is reported on the standard error; the writer keeps running for the next batch.
			if _, err := f.file.Write(f.batch); err != nil {
				fmt.Fprintf(os.Stderr, "event writer: %v\n", err)
			}
			f.batch = f.batch[:0]
		}
	}
	appendLine := func(f *outputFile, e *pendingEvent) {
		seq++
		line, err := serializeEvent(seq, e)
		if err != nil {
			// The line is not written; the seq stays taken, so the audit shows the gap next to this report.
			fmt.Fprintf(os.Stderr, "event writer: %s cannot be written: %v\n", e.event, err)
			return
		}
		f.batch = append(f.batch, line...)
	}
	push := func(e *pendingEvent) {
		f := files[channelOf(e.level)]
		if f.file == nil {
			file, err := os.OpenFile(f.path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if err != nil {
				// The event is not written; its seq stays taken, so the audit shows the gap next to this report.
				seq++
				fmt.Fprintf(os.Stderr, "event writer: %s cannot be written: %v\n", e.event, err)
				return
			}
			f.file = file
			appendLine(f, writerEvent(LevelInfo, "log.open", l.openFields))
		}
		appendLine(f, e)
	}
	push(open)
	// recordLoss stores one log.dropped for each channel after the range of seq that the refused events would have had.
	recordLoss := func() {
		for c := channel(0); c < channelCount; c++ {
			events := l.lost[c].events.Swap(0)
			bytes := l.lost[c].bytes.Swap(0)
			if events == 0 {
				continue
			}
			// The refused events had no seq. Their numbers are skipped, and log.dropped is stored after the range that it
			// names (docs/spec/logging.md#event).
			from := seq + 1
			seq += events
			// The fields are numbers and fixed texts, so they are written as text without a serializer that can fail.
			fields := json.RawMessage(fmt.Sprintf(`{"from_seq":%d,"to_seq":%d,"count":%d,"bytes":%d,"reason":%q,"channel":%q}`, from, seq, events, bytes, "the queue was full", c.name()))
			push(writerEvent(LevelWarn, "log.dropped", fields))
		}
	}
	take := func(e *pendingEvent) {
		l.queuedBytes.Add(-int64(e.bytes))
		l.queuedEvents.Add(-1)
		push(e)
	}
	write := func() {
		recordLoss()
		flush()
	}
	// drain takes every event that is queued now, writes them, and returns the request that it met, if any.
	drain := func() *eventMessage {
		for {
			select {
			case message := <-l.messages:
				if message.event != nil {
					take(message.event)
					continue
				}
				write()
				return &message
			default:
				write()
				return nil
			}
		}
	}
	answer := func(request *eventMessage) bool {
		if request.flush != nil {
			close(request.flush)
		}
		return request.stop
	}
	timer := time.NewTimer(eventBatchInterval)
	defer timer.Stop()
	for {
		select {
		case message := <-l.messages:
			if message.event != nil {
				urgent := message.event.level == LevelError
				take(message.event)
				if urgent {
					write()
				}
				continue
			}
			// The queue is in order, so every event before the request is already taken; the request writes them and answers.
			write()
			if answer(&message) {
				return
			}
		case <-timer.C:
			if request := drain(); request != nil && answer(request) {
				return
			}
			timer.Reset(eventBatchInterval)
		}
	}
}
