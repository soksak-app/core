package sok

// The event writer of the hosts and of the tool (docs/spec/logging.md#writers).
//
// A producer pushes an event to a queue bounded by count and by bytes without waiting. One writer goroutine assigns seq,
// serializes the JSON line, writes batches, rotates the files when it has a bound, and records the events that the queue
// refused as log.dropped. It writes two files, the main file of the levels error, warn and info and the debug file of the levels
// debug and trace, with one seq across both, and it asks the policy gate for every event of a declared name. The hosts and the tool start this writer with their own layer, role, clock and goroutine entrance;
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
	// RotateBytes is the size at which the writer starts a new file. Each of the two files of the writer rotates on its own: the
	// file that was full becomes the next generation (`.1` is the first), and rotation removes no generation. It is 0 for a
	// writer that does not rotate.
	RotateBytes int64
	// PolicyPath is the policy file that the writer follows (`<config-dir>/log-policy.json`); it is empty for a writer that has none.
	PolicyPath string
	// Prune, when it is set, runs on the goroutine of the writer after log.open and after each rotation. It applies the retention of
	// the files of the runs; when it removed a file or left the files over the bound it returns the level and the fields of the event
	// log.pruned, which the writer stores, and true.
	Prune func() (level Level, fields json.RawMessage, stored bool)
	// Pull takes the events of a source that cannot call into the writer. It runs on the goroutine of the writer at the batch
	// interval and when it flushes: it passes each event to accept, and each loss of the source (events, bytes, the reason and the
	// channel of the lost events) to lost. It is nil when the process has no such source.
	Pull func(accept func(RelayedEvent), lost func(events, bytes uint64, reason string, channel Channel))
}

// Channel is the set of the files of a process that holds a set of levels (docs/spec/logging.md#files): the channel other holds
// error, warn and info in the main file, and the channel debug holds debug and trace in the debug file.
type Channel int

// The channels of the writer.
const (
	ChannelOther Channel = iota
	ChannelDebug
	// ChannelCount is the number of channels.
	ChannelCount
)

// String is the name of the channel in log.dropped and in the query.
func (c Channel) String() string {
	if c == ChannelDebug {
		return "debug"
	}
	return "other"
}

// ChannelOf returns the channel that stores the level.
func ChannelOf(level Level) Channel {
	if level == LevelDebug || level == LevelTrace {
		return ChannelDebug
	}
	return ChannelOther
}

// pendingEvent is one event waiting for the writer. seq is assigned when the writer serializes it.
type pendingEvent struct {
	tsMicros int64
	// monoNs is the monotonic clock at the occurrence.
	monoNs uint64
	// cids are the correlation identifiers of the inputs the event belongs to.
	cids  []string
	layer string
	// page is the time origin of the document that wrote an event of the layer page or plugin, and empty for another layer.
	page  string
	level Level
	event string
	// class is the class that the catalog declares for the event; it is empty, and undeclared is set, for a name the catalog does not declare.
	class      Class
	undeclared bool
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

// gatedReportInterval is the interval between two reports of the counts of the gate (docs/spec/logging.md#policy).
const gatedReportInterval = time.Second

// EventLog is the writer of one process.
type EventLog struct {
	messages     chan eventMessage
	queuedEvents atomic.Int64
	queuedBytes  atomic.Int64
	queueEvents  int64
	queueBytes   int64
	// lost counts what the queue and the producers refused, for each channel.
	lost [ChannelCount]struct{ events, bytes, depth atomic.Uint64 }
	// gate is the policy in force and the count of the events that it refused.
	gate        *eventGate
	policyPath  string
	prune       func() (Level, json.RawMessage, bool)
	path        string
	debugPath   string
	boot        string
	rotateBytes int64
	openFields  json.RawMessage
	layer       string
	clock       func() uint64
	pull        func(accept func(RelayedEvent), lost func(events, bytes uint64, reason string, channel Channel))
	done        chan struct{}
	closeOnce   sync.Once
	onWrite     atomic.Pointer[func(path string, size int64)]
	// pluginClasses holds the classes that the catalogs of the installed plugins declare (docs/spec/logging.md#plugin-catalogs).
	pluginClasses atomic.Pointer[map[string]Class]
}

// SetPluginClasses replaces the classes of the plugin events, which the host reads from the catalogs of the enabled installed
// plugins when it starts and after each change of the installed plugins.
func (l *EventLog) SetPluginClasses(classes map[string]Class) {
	l.pluginClasses.Store(&classes)
}

// SetOnWrite sets the observer that the writer calls after it wrote a batch, with the path of the file and its size. It is
// called on the goroutine of the writer, so it must not wait.
func (l *EventLog) SetOnWrite(observer func(path string, size int64)) {
	l.onWrite.Store(&observer)
}

// StartEventLog creates the folder (mode 0700) and the main file (mode 0600, created new), writes log.open and starts the writer.
// The debug file is created with its first event.
func StartEventLog(options EventLogOptions) (*EventLog, error) {
	if options.Layer == "" || options.Clock == nil || options.Spawn == nil {
		return nil, fmt.Errorf("event writer: Layer, Clock and Spawn must be set")
	}
	if options.RotateBytes < 0 {
		return nil, fmt.Errorf("event writer: RotateBytes must not be negative, not %d", options.RotateBytes)
	}
	if err := os.MkdirAll(options.Directory, 0o700); err != nil {
		return nil, err
	}
	// A folder that existed before keeps its mode; the log folder of the contract is private.
	if err := os.Chmod(options.Directory, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(options.Directory, fmt.Sprintf("%s-%s.jsonl", options.Role, options.Boot))
	debugPath := filepath.Join(options.Directory, fmt.Sprintf("%s-%s.debug.jsonl", options.Role, options.Boot))
	file, err := openLogFile(path)
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
		gate:        newEventGate(),
		policyPath:  options.PolicyPath,
		prune:       options.Prune,
		path:        path,
		debugPath:   debugPath,
		boot:        options.Boot,
		rotateBytes: options.RotateBytes,
		openFields:  fields,
		layer:       options.Layer,
		clock:       options.Clock,
		pull:        options.Pull,
		done:        make(chan struct{}),
	}
	open := log.writerEvent(LevelInfo, "log.open", fields)
	options.Spawn("event-log-writer", func() { log.write(file, options.BatchInterval, open) })
	return log, nil
}

// openLogFile creates a file of the writer (mode 0600, created new). os.OpenFile opens it close-on-exec, so a child process does not
// inherit it.
func openLogFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_APPEND|os.O_WRONLY, 0o600)
}

// CountLoss adds events and bytes of a channel that a producer of this process refused before they reached the writer; the
// writer records them as a log.dropped that names the channel.
func (l *EventLog) CountLoss(channel Channel, events, bytes uint64) {
	l.lost[channel].events.Add(events)
	l.lost[channel].bytes.Add(bytes)
	raiseDepth(&l.lost[channel].depth, l.queuedEvents.Load())
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
	if l.queuedEvents.Load() >= l.queueEvents {
		l.countLoss(ChannelOf(level), len(event))
		return 0, fmt.Errorf("the event writer refused %s because %w", event, errQueueFull)
	}
	if err := l.enqueuePlaced(time.Now().UnixMicro(), l.clock(), l.layer, "", level, event, nil, fields, produced, placed); err != nil {
		return 0, fmt.Errorf("the event writer refused %s because %w", event, err)
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

// Path is the main file of this run (error, warn and info); DebugPath is the debug file (debug and trace), which exists once the
// first event of the channel debug was written.
func (l *EventLog) Path() string { return l.path }

// DebugPath is the debug file of this run.
func (l *EventLog) DebugPath() string { return l.debugPath }

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
		l.countLoss(ChannelOf(level), len(event))
		fmt.Fprintf(os.Stderr, "event writer: %s has the level %q, which the contract does not define\n", event, string(level))
		return false
	}
	if err := CheckCids(cids); err != nil {
		l.countLoss(ChannelOf(level), len(event))
		fmt.Fprintf(os.Stderr, "event writer: the cids of %s are refused: %v\n", event, err)
		return false
	}
	// A closed gate builds nothing: the fields are not serialized for an event that the policy does not store.
	if class, declared := EventClassOf(event); declared && !PassesEveryGate(event) && !l.Gate(class, level) {
		return false
	}
	if l.queuedEvents.Load() >= l.queueEvents {
		l.countLoss(ChannelOf(level), len(event))
		return false
	}
	text, produced, err := BoundedMarshal(fields, EventFieldsLimitBytes)
	if err != nil {
		// A value that cannot be serialized is a defect of the caller; it is counted in place of the event.
		l.countLoss(ChannelOf(level), len(event))
		fmt.Fprintf(os.Stderr, "event writer: the fields of %s cannot be serialized: %v\n", event, err)
		return false
	}
	return l.enqueue(time.Now().UnixMicro(), l.clock(), l.layer, level, event, cids, text, produced) == nil
}

// layers are the layers of the event contract that another layer of a process relays (docs/spec/logging.md#event).
var layers = []string{"native", "host", "page", "plugin", "sidecar"}

// RelayedEvent is an event that another layer of this process produced, with the clocks and the layer it carries.
type RelayedEvent struct {
	TsMicros int64
	MonoNs   uint64
	Layer    string
	// Page is the time origin of the document that wrote the event; an event of the layer page or plugin requires it.
	Page  string
	Level Level
	Event string
	Cids  []string
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
	if documentLayer := e.Layer == "page" || e.Layer == "plugin"; documentLayer != (e.Page != "") {
		return false, fmt.Errorf("the event %s of the layer %s names the page %q; only an event of the layer page or plugin names one, and it must", e.Event, e.Layer, e.Page)
	}
	// page.start passes every gate: the first module of the page emits it before the policy reaches the gate of the page, and a
	// reader finds the start of each document by it (docs/spec/logging.md#policy).
	if class, declared := EventClassOf(e.Event); declared && !PassesEveryGate(e.Event) && !l.Gate(class, e.Level) {
		return false, nil
	}
	if l.queuedEvents.Load() >= l.queueEvents {
		l.countLoss(ChannelOf(e.Level), len(e.Event))
		return false, nil
	}
	return l.enqueuePlaced(e.TsMicros, e.MonoNs, e.Layer, e.Page, e.Level, e.Event, e.Cids, e.Fields, e.Produced, nil) == nil, nil
}

func (l *EventLog) enqueue(tsMicros int64, monoNs uint64, layer string, level Level, event string, cids []string, text json.RawMessage, produced int) error {
	return l.enqueuePlaced(tsMicros, monoNs, layer, "", level, event, cids, text, produced, nil)
}

// enqueuePlaced queues an event. produced is 0 for fields that are JSON, which the writer cuts when they are over the bound,
// and for fields that the producer cut at the bound the number of bytes it had written when it stopped; text is then the first
// bytes of the text.
func (l *EventLog) enqueuePlaced(tsMicros int64, monoNs uint64, layer, page string, level Level, event string, cids []string, text json.RawMessage, produced int, placed chan uint64) error {
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
		l.countLoss(ChannelOf(level), bytes)
		return errQueueFull
	}
	pending := &pendingEvent{tsMicros: tsMicros, monoNs: monoNs, cids: cids, layer: layer, page: page, level: level, event: event, fields: text, bytes: bytes, truncated: truncated, placed: placed}
	l.classify(pending)
	// A closed gate stores nothing and counts the event; an event that the catalog does not declare has no class and no gate, and
	// page.start passes every gate.
	if pending.class != "" && !PassesEveryGate(event) && !l.Gate(pending.class, level) {
		return errPolicy
	}
	return l.queue(pending)
}

// queue hands a counted event to the writer; a full queue refuses it and counts the loss.
func (l *EventLog) queue(pending *pendingEvent) error {
	l.queuedBytes.Add(int64(pending.bytes))
	l.queuedEvents.Add(1)
	select {
	case l.messages <- eventMessage{event: pending}:
		return nil
	default:
		l.queuedBytes.Add(-int64(pending.bytes))
		l.queuedEvents.Add(-1)
		l.countLoss(ChannelOf(pending.level), pending.bytes)
		return errQueueFull
	}
}

// enqueueWriterEvent queues an event that the writer reports about itself (log.policy) from another goroutine. These events pass
// every gate: a policy that turns a class off must still be able to say that it did.
func (l *EventLog) enqueueWriterEvent(level Level, name string, fields json.RawMessage) bool {
	// events: forwarded
	pending := l.writerEvent(level, name, fields)
	pending.bytes = len(fields) + len(name)
	if l.queuedBytes.Load()+int64(pending.bytes) > l.queueBytes {
		l.countLoss(ChannelOf(level), pending.bytes)
		return false
	}
	return l.queue(pending) == nil
}

// RecordClosed queues the event `log.closed` that the writer reports when a host process ends (docs/spec/logging.md#self-reports).
// cause is `exit`, `exit-request` or `signal`, and signal is the number of the termination signal of the cause `signal`. It
// returns false when the queue has no room.
func (l *EventLog) RecordClosed(cause string, signal *int) bool {
	fields := map[string]any{"cause": cause}
	if signal != nil {
		fields["signal"] = *signal
	}
	text, err := json.Marshal(fields)
	if err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the fields of log.closed cannot be serialized: %v\n", err)
		return false
	}
	return l.enqueueWriterEvent(LevelInfo, "log.closed", text)
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

func (l *EventLog) countLoss(channel Channel, bytes int) {
	l.lost[channel].events.Add(1)
	l.lost[channel].bytes.Add(uint64(bytes))
	raiseDepth(&l.lost[channel].depth, l.queuedEvents.Load())
}

// raiseDepth keeps the largest depth of the queue that a refusal of the channel saw since the writer last recorded the loss.
func raiseDepth(depth *atomic.Uint64, queued int64) {
	for {
		current := depth.Load()
		if uint64(queued) <= current || depth.CompareAndSwap(current, uint64(queued)) {
			return
		}
	}
}

// The causes of a refusal by the queue, which a placed event names in its error (docs/spec/logging.md#policy).
var (
	errQueueFull = errors.New("its queue was full")
	errPolicy    = errors.New("the policy does not store it")
)

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

// classify gives the event the class that the catalog declares for its name: the core catalog, or the catalog of the installed
// plugin of a plugin event. An event of the layer plugin that no catalog declares takes the class lifecycle and is marked
// undeclared, and it is gated as lifecycle (docs/spec/logging.md#principles); another name that no catalog declares is stored
// without a class and marked undeclared (docs/spec/logging.md#event).
func (l *EventLog) classify(e *pendingEvent) {
	e.class, e.undeclared = "", false
	if class, declared := EventClassOf(e.event); declared {
		e.class = class
	} else if classes := l.pluginClasses.Load(); classes != nil && (*classes)[e.event] != "" {
		e.class = (*classes)[e.event]
	} else if e.layer == "plugin" {
		e.class, e.undeclared = ClassLifecycle, true
	} else {
		e.undeclared = true
	}
}

// writerEvent is an event that the writer itself creates (log.open, log.rotated, log.dropped), with both clocks read now.
func (l *EventLog) writerEvent(level Level, event string, fields json.RawMessage) *pendingEvent {
	e := &pendingEvent{tsMicros: time.Now().UnixMicro(), monoNs: l.clock(), layer: l.layer, level: level, event: event, fields: fields}
	l.classify(e)
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
	Page     string          `json:"page,omitempty"`
	Event    string          `json:"event"`
	Cids     []string        `json:"cids,omitempty"`
	Fields   json.RawMessage `json:"fields"`
	// Undeclared is true for an event whose name the catalog does not declare; such a line has no class.
	Undeclared bool `json:"undeclared,omitempty"`
	// Truncated is the size in bytes of the fields before they were cut; it is absent for an event that was not cut.
	Truncated int `json:"truncated,omitempty"`
}

// marshalRecord serializes a record of the writer. A test replaces it to fail the serialization of one event.
var marshalRecord = func(record eventRecord) ([]byte, error) { return json.Marshal(record) }

func serializeEvent(seq uint64, e *pendingEvent) ([]byte, error) {
	line, err := marshalRecord(eventRecord{TsMicros: e.tsMicros, MonoNs: e.monoNs, Seq: seq, Level: e.level, Class: e.class, Layer: e.layer, Page: e.page, Event: e.event, Cids: e.cids, Fields: e.fields, Undeclared: e.undeclared, Truncated: e.truncated})
	if err != nil {
		return nil, err
	}
	return append(line, '\n'), nil
}

// logFile is one file of the writer: the main file of the channel other or the debug file of the channel debug. Only the
// goroutine of the writer uses it.
type logFile struct {
	path string
	// file is nil until the first line of the channel is written: the debug file is created when the first debug or trace
	// event arrives, so a run that stores no such event leaves no empty file.
	file *os.File
	// size is the number of bytes of the current file, written or waiting in the batch.
	size int64
	// generation is the number of the last generation that rotation closed; 0 before the first rotation.
	generation int
	batch      []byte
}

// rotate closes the full file of f as the next generation (`<path>.<n>`, with n counted from 1 in the order of the rotations),
// opens a new file at the path, and moves the index file with the closed generation (docs/spec/logging.md#index). No generation
// is removed or renamed. It returns the number of the generation and true; when a step fails the failure is reported, the files
// are as they were, and the writer keeps the file it has.
func (l *EventLog) rotate(f *logFile) (int, bool) {
	n := f.generation + 1
	var next *os.File
	err := RotateLogIndexes(f.path, n, func() error {
		var err error
		next, err = l.rotateFiles(f, n)
		return err
	})
	if next == nil {
		fmt.Fprintf(os.Stderr, "event writer: %v\n", err)
		return 0, false
	}
	if err != nil {
		// The files rotated; only the index of the closed file is not complete, and a query builds it again.
		fmt.Fprintf(os.Stderr, "event writer: the index of the rotated file is not complete: %v\n", err)
	}
	return n, true
}

// rotateFiles renames the full file to generation n and opens the new file; it closes the full file and stores the new one in f.
// When the new file cannot be opened the rename is undone, so the writer keeps writing the file at its path.
func (l *EventLog) rotateFiles(f *logFile, n int) (*os.File, error) {
	generation := fmt.Sprintf("%s.%d", f.path, n)
	if err := os.Rename(f.path, generation); err != nil {
		return nil, fmt.Errorf("rotation could not move %s: %v", f.path, err)
	}
	next, err := openLogFile(f.path)
	if err != nil {
		if undo := os.Rename(generation, f.path); undo != nil {
			fmt.Fprintf(os.Stderr, "event writer: rotation could not undo the move of %s: %v\n", f.path, undo)
		}
		return nil, fmt.Errorf("rotation could not open %s: %v", f.path, err)
	}
	if err := f.file.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "event writer: rotation could not close the full file: %v\n", err)
	}
	f.file = next
	return next, nil
}

func (l *EventLog) write(main *os.File, interval time.Duration, open *pendingEvent) {
	defer close(l.done)
	files := [ChannelCount]*logFile{
		ChannelOther: {path: l.path, file: main},
		ChannelDebug: {path: l.debugPath},
	}
	defer func() {
		for _, f := range files {
			if f.file != nil {
				if err := f.file.Close(); err != nil {
					fmt.Fprintf(os.Stderr, "event writer: %v\n", err)
				}
			}
		}
	}()
	var seq uint64
	// prune runs the retention of the process and stores the event log.pruned; rotatedFile says that the push that is running
	// rotated a file.
	var prune func()
	rotatedFile := false
	flushFile := func(f *logFile) {
		if len(f.batch) == 0 {
			return
		}
		// A failed write is reported on the standard error; the writer keeps running for the next batch.
		if _, err := f.file.Write(f.batch); err != nil {
			fmt.Fprintf(os.Stderr, "event writer: %v\n", err)
		} else if observer := l.onWrite.Load(); observer != nil {
			(*observer)(f.file.Name(), f.size)
		}
		f.batch = f.batch[:0]
	}
	flush := func() {
		for _, f := range files {
			flushFile(f)
		}
	}
	// push queues an event into the file of its channel; appendLine reports a line it cannot serialize through it.
	var push func(e *pendingEvent)
	appendLine := func(f *logFile, e *pendingEvent) {
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
			// The line is not written; the seq stays taken and log.dropped names that gap with its cause after it (logging.md). The
			// record of a loss is not reported again when its own line cannot be serialized.
			fmt.Fprintf(os.Stderr, "event writer: %s cannot be written: %v\n", e.event, err)
			if e.event != "log.dropped" {
				reason, _ := json.Marshal("the line cannot be serialized: " + err.Error())
				push(l.writerEvent(LevelWarn, "log.dropped", json.RawMessage(fmt.Sprintf(
					`{"from_seq":%d,"to_seq":%d,"count":1,"bytes":%d,"reason":%s,"channel":%q}`,
					seq, seq, len(e.event), reason, ChannelOf(e.level).String()))))
			}
			return
		}
		f.batch = append(f.batch, line...)
		f.size += int64(len(line))
	}
	push = func(e *pendingEvent) {
		f := files[ChannelOf(e.level)]
		if f.file == nil {
			file, err := openLogFile(f.path)
			if err != nil {
				// The event is not written; its seq stays taken, so the audit shows the gap next to this report.
				seq++
				if e.placed != nil {
					close(e.placed)
				}
				fmt.Fprintf(os.Stderr, "event writer: %s cannot be written: %v\n", e.event, err)
				return
			}
			f.file = file
			appendLine(f, l.writerEvent(LevelInfo, "log.open", l.openFields))
		}
		// The line is serialized with the next seq. A file that this line would take past the bound is closed first; the new
		// file opens with log.open and the record of the rotation, so every file of the contract starts with log.open and seq
		// continues.
		line, err := serializeEvent(seq+1, e)
		if err == nil && l.rotateBytes > 0 && f.size > 0 && f.size+int64(len(line)) > l.rotateBytes {
			flushFile(f)
			full := f.size
			if n, rotated := l.rotate(f); rotated {
				f.generation = n
				f.size = 0
				appendLine(f, l.writerEvent(LevelInfo, "log.open", l.openFields))
				appendLine(f, l.writerEvent(LevelInfo, "log.rotated", json.RawMessage(fmt.Sprintf(`{"bytes":%d,"generation":%d}`, full, n))))
				rotatedFile = true
			}
		}
		appendLine(f, e)
		// A rotation closes a file of the run, so the files may have passed the bound: the retention runs after the line that caused it.
		if rotatedFile {
			rotatedFile = false
			prune()
		}
	}
	prune = func() {
		if l.prune == nil {
			return
		}
		if level, fields, stored := l.prune(); stored {
			push(l.writerEvent(level, "log.pruned", fields))
		}
	}
	push(open)
	prune()
	// dropped stores one log.dropped after the range of seq that the refused events would have had; channel is the channel of the
	// refused events.
	dropped := func(events, bytes uint64, reason string, channel Channel, queued *uint64) {
		if events == 0 {
			return
		}
		// The refused events had no seq. Their numbers are skipped, and log.dropped is stored after the range that it
		// names (docs/spec/logging.md#event).
		from := seq + 1
		seq += events
		// The fields are numbers and fixed texts, so they are written as text without a serializer that can fail.
		text := fmt.Sprintf(`{"from_seq":%d,"to_seq":%d,"count":%d,"bytes":%d,"reason":%q,"channel":%q`,
			from, seq, events, bytes, reason, channel.String())
		if queued != nil {
			text += fmt.Sprintf(`,"queued":%d`, *queued)
		}
		fields := json.RawMessage(text + "}")
		push(l.writerEvent(LevelWarn, "log.dropped", fields))
	}
	// pull takes the events of the source of the process. No event source reaches the writer from there (a native thread
	// must not call into Go), so the writer pulls at its batch interval and when it flushes.
	pull := func() {
		if l.pull == nil {
			return
		}
		l.pull(func(e RelayedEvent) {
			pending := &pendingEvent{tsMicros: e.TsMicros, monoNs: e.MonoNs, cids: e.Cids, layer: e.Layer, level: e.Level, event: e.Event, fields: e.Fields}
			l.classify(pending)
			push(pending)
		}, func(events, bytes uint64, reason string, channel Channel) {
			dropped(events, bytes, reason, channel, nil)
		})
	}
	recordLoss := func() {
		for channel := Channel(0); channel < ChannelCount; channel++ {
			events := l.lost[channel].events.Swap(0)
			bytes := l.lost[channel].bytes.Swap(0)
			queued := l.lost[channel].depth.Swap(0)
			dropped(events, bytes, "the queue was full", channel, &queued)
		}
	}
	// reportGated reports the events that the gate refused with the exact count for each class and level, each second and
	// at a flush or a stop (force): a report at each batch interval stored more events than a narrow policy removed.
	gatedAt := time.Now()
	reportGated := func(force bool) {
		if !force && time.Since(gatedAt) < gatedReportInterval {
			return
		}
		gatedAt = time.Now()
		for c, class := range Classes {
			for i, level := range levelNames {
				if count := l.gate.gated[c][i].Swap(0); count > 0 {
					push(l.writerEvent(LevelInfo, "log.gated", json.RawMessage(fmt.Sprintf(`{"class":%q,"level":%q,"count":%d}`, class, level, count))))
				}
			}
		}
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
				reportGated(true)
				write()
				return &message
			default:
				recordLoss()
				reportGated(false)
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
			reportGated(true)
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
