package host

// The event writer of the host (docs/spec/logging.md#writers).
//
// A producer pushes an event to a queue bounded by count and by bytes without waiting. One writer goroutine assigns
// seq, serializes the JSON line, writes batches and records the events that the queue refused as log.dropped.

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// EventLogSchema is the schema number of the lines that this writer writes. Schema 2 adds `mono_ns` to every line.
const EventLogSchema = 2

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

// checkCids refuses a list of correlation identifiers that the line of an event cannot carry: an identifier is not empty and
// holds no quote, no backslash and no control character, so a native record and a line write it without escaping.
func checkCids(cids []string) error {
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
	// QueueEvents is the bound of the queue in events.
	QueueEvents int
	// QueueBytes is the bound of the queue in bytes of serialized fields.
	QueueBytes int
	// BatchInterval is how long the writer waits for more events before it writes a batch.
	BatchInterval time.Duration
	// PolicyPath is the policy file that the writer follows (`<config-dir>/log-policy.json`); it is empty for a writer that has none.
	PolicyPath string
	// RetentionBytes is the bound of the files of the runs in the folder (docs/spec/logging.md#retention): the writer removes the oldest
	// runs when it starts and after each rotation while the files pass it.
	RetentionBytes int64
	// RotateBytes is the size at which the writer starts a new file. Each of the two files of the writer (the main file and the
	// debug file) rotates on its own: the file that was full becomes the next generation (`.1` is the first), and rotation
	// removes no generation.
	RotateBytes int64
	// Pull moves whole records of the native ring into buffer and returns the number of bytes written; nil when the
	// process has no native ring. PullLoss returns the events and bytes that the ring refused in a channel since the last call.
	Pull     func(buffer []byte) (int, error)
	PullLoss func(channel Channel) (events, bytes uint64)
}

// Channel is the set of the files of a process that holds a set of levels (docs/spec/logging.md#files): the channel other holds
// error, warn and info in the main file, and the channel debug holds debug and trace in the debug file.
type Channel int

// The channels of the writer.
const (
	ChannelOther Channel = iota
	ChannelDebug
	channelCount
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
	level Level
	event string
	// class is the class that the catalog declares for the event; it is empty, and undeclared is set, for a name the catalog does not declare.
	class      sok.Class
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

// EventLog is the writer of one process.
type EventLog struct {
	messages     chan eventMessage
	queuedEvents atomic.Int64
	queuedBytes  atomic.Int64
	queueEvents  int64
	queueBytes   int64
	// lost counts what the queue and the producers refused, for each channel.
	lost [channelCount]struct{ events, bytes atomic.Uint64 }
	// gate is the policy in force and the count of the events that it refused.
	gate        *eventGate
	policyPath  string
	directory   string
	runName     string
	retention   int64
	path        string
	debugPath   string
	boot        string
	rotateBytes int64
	openFields  json.RawMessage
	pull        func(buffer []byte) (int, error)
	pullLoss    func(Channel) (uint64, uint64)
	done        chan struct{}
	closeOnce   sync.Once
	onWrite     atomic.Pointer[func(path string, size int64)]
}

// SetOnWrite sets the observer that the writer calls after it wrote a batch, with the path of the file and its size. It is
// called on the goroutine of the writer, so it must not wait.
func (l *EventLog) SetOnWrite(observer func(path string, size int64)) {
	l.onWrite.Store(&observer)
}

// StartEventLog creates the folder (mode 0700) and the file (mode 0600), writes log.open and starts the writer.
func StartEventLog(options EventLogOptions) (*EventLog, error) {
	if options.RotateBytes <= 0 {
		return nil, fmt.Errorf("event writer: RotateBytes must be positive, not %d", options.RotateBytes)
	}
	if options.RetentionBytes <= 0 {
		return nil, fmt.Errorf("event writer: RetentionBytes must be positive, not %d", options.RetentionBytes)
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
		directory:   options.Directory,
		runName:     options.Role + "-" + options.Boot,
		retention:   options.RetentionBytes,
		path:        path,
		debugPath:   debugPath,
		boot:        options.Boot,
		rotateBytes: options.RotateBytes,
		openFields:  fields,
		pull:        options.Pull,
		pullLoss:    options.PullLoss,
		done:        make(chan struct{}),
	}
	open := writerEvent(LevelInfo, "log.open", fields)
	routine.Go("event-log-writer", func() { log.write(file, options.BatchInterval, open) })
	return log, nil
}

// The bounds of the writer of a host: events and bytes of serialized fields waiting for the batch interval.
const (
	hostQueueEvents   = 8192
	hostQueueBytes    = 16 << 20
	hostBatchInterval = 100 * time.Millisecond
	hostRotateBytes   = 100 << 20
)

var (
	bootOnce sync.Once
	bootName string
)

// processBoot is the identifier of this run, shared by the files of the run: the start time in seconds and the process
// identifier.
func processBoot() string {
	bootOnce.Do(func() { bootName = fmt.Sprintf("%d-%d", time.Now().Unix(), os.Getpid()) })
	return bootName
}

// StandardErrorPath is the stderr file of this run under the logs folder of config.
func StandardErrorPath(config string) string {
	return filepath.Join(config, "logs", "host-"+processBoot()+".stderr")
}

// StartHostEventLog starts the writer of the host in logs/ of the configuration folder; the boot identifier is the
// start time in seconds and the process identifier.
func StartHostEventLog(config string) (*EventLog, error) {
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	// A platform that cannot pull the native ring fails here, at the start, instead of running without native events.
	if _, err := system.PullNativeEvents(make([]byte, 1)); err != nil {
		return nil, err
	}
	if err := system.SetEventBoot(processBoot()); err != nil {
		return nil, err
	}
	if err := system.ObserveActivity(); err != nil {
		return nil, err
	}
	return StartEventLog(EventLogOptions{
		Pull: system.PullNativeEvents,
		PullLoss: func(channel Channel) (uint64, uint64) {
			events, bytes, err := system.TakeNativeEventLoss(uint8(channel))
			if err != nil {
				fmt.Fprintf(os.Stderr, "event writer: the loss of the native ring cannot be read: %v\n", err)
			}
			return events, bytes
		},
		Directory: filepath.Join(config, "logs"), Role: "host", Boot: processBoot(),
		QueueEvents: hostQueueEvents, QueueBytes: hostQueueBytes, BatchInterval: hostBatchInterval,
		RotateBytes: hostRotateBytes, PolicyPath: filepath.Join(config, "log-policy.json"), RetentionBytes: hostRetentionBytes,
	})
}

// CountLoss adds events and bytes of a channel that a producer of this process refused before they reached the writer; the
// writer records them as a log.dropped that names the channel.
func (l *EventLog) CountLoss(channel Channel, events, bytes uint64) {
	l.lost[channel].events.Add(events)
	l.lost[channel].bytes.Add(bytes)
}

// Boot is the identifier of the run that this writer belongs to; with a seq it names a line of the log.
func (l *EventLog) Boot() string { return l.boot }

// EmitPlaced queues an event of the layer host, waits until it is on disk, at most deadline, and returns its seq. The queue
// refusing the event is an error, so a caller that stores the position never stores a position of a line that does not exist.
func (l *EventLog) EmitPlaced(level Level, event string, fields json.RawMessage, deadline time.Duration) (uint64, error) {
	if !json.Valid(fields) {
		return 0, fmt.Errorf("the fields of %s are not JSON", event)
	}
	return l.emitPlaced(level, event, fields, 0, deadline)
}

// emitPlaced is EmitPlaced for fields that are JSON, or, when produced is not 0, the first bytes of the text that the
// producer stopped at the bound after it had written produced bytes.
func (l *EventLog) emitPlaced(level Level, event string, fields []byte, produced int, deadline time.Duration) (uint64, error) {
	placed := make(chan uint64, 1)
	if !l.enqueuePlaced(time.Now().UnixMicro(), monotonicNanos(), "host", level, event, nil, fields, produced, placed) {
		return 0, fmt.Errorf("the event writer refused %s because its queue was full or the policy does not store it", event)
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

// Path is the main file of the writer (error, warn and info); DebugPath is the debug file (debug and trace), which exists once
// the first event of the channel debug was written.
func (l *EventLog) Path() string { return l.path }

// DebugPath is the debug file of the writer.
func (l *EventLog) DebugPath() string { return l.debugPath }

// Emit queues an event. It returns false, and counts the loss, when the queue has no room. It never waits. The fields
// are serialized once, and only after the queue is known to have room for another event.
func (l *EventLog) Emit(level Level, event string, fields any) bool {
	switch level {
	case LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace:
	default:
		// A level outside the contract is a defect of the caller; the event is counted as lost and the defect is reported.
		l.countLoss(ChannelOf(level), len(event))
		fmt.Fprintf(os.Stderr, "event writer: %s has the level %q, which the contract does not define\n", event, string(level))
		return false
	}
	// A closed gate builds nothing: the fields are not serialized for an event that the policy does not store.
	if class, declared := sok.EventClassOf(event); declared && !l.Gate(class, level) {
		return false
	}
	if l.queuedEvents.Load() >= l.queueEvents {
		l.countLoss(ChannelOf(level), len(event))
		return false
	}
	text, produced, err := boundedMarshal(fields, EventFieldsLimitBytes)
	if err != nil {
		// A value that cannot be serialized is a defect of the caller; it is counted in place of the event.
		l.countLoss(ChannelOf(level), len(event))
		fmt.Fprintf(os.Stderr, "event writer: the fields of %s cannot be serialized: %v\n", event, err)
		return false
	}
	return l.enqueue(time.Now().UnixMicro(), monotonicNanos(), "host", level, event, nil, text, produced)
}

// EmitCids queues an event of the layer host like Emit, with the correlation identifiers of the inputs it belongs to. An
// identifier that a line cannot carry is a defect of the caller: it is reported on the standard error, counted as lost, and
// the event is refused.
func (l *EventLog) EmitCids(level Level, event string, cids []string, fields any) bool {
	if err := checkCids(cids); err != nil {
		l.countLoss(ChannelOf(level), len(event))
		fmt.Fprintf(os.Stderr, "event writer: the cids of %s are refused: %v\n", event, err)
		return false
	}
	if class, declared := sok.EventClassOf(event); declared && !l.Gate(class, level) {
		return false
	}
	if l.queuedEvents.Load() >= l.queueEvents {
		l.countLoss(ChannelOf(level), len(event))
		return false
	}
	text, produced, err := boundedMarshal(fields, EventFieldsLimitBytes)
	if err != nil {
		l.countLoss(ChannelOf(level), len(event))
		fmt.Fprintf(os.Stderr, "event writer: the fields of %s cannot be serialized: %v\n", event, err)
		return false
	}
	return l.enqueue(time.Now().UnixMicro(), monotonicNanos(), "host", level, event, cids, text, produced)
}

// layers are the layers of the event contract (docs/spec/logging.md#event).
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
	if err := checkCids(e.Cids); err != nil {
		return false, fmt.Errorf("the cids of %s: %w", e.Event, err)
	}
	if class, declared := sok.EventClassOf(e.Event); declared && !l.Gate(class, e.Level) {
		return false, nil
	}
	if l.queuedEvents.Load() >= l.queueEvents {
		l.countLoss(ChannelOf(e.Level), len(e.Event))
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
		l.countLoss(ChannelOf(level), bytes)
		return false
	}
	pending := &pendingEvent{tsMicros: tsMicros, monoNs: monoNs, cids: cids, layer: layer, level: level, event: event, fields: text, bytes: bytes, truncated: truncated, placed: placed}
	pending.classify()
	// A closed gate stores nothing and counts the event; an event that the catalog does not declare has no class and no gate.
	if pending.class != "" && !l.Gate(pending.class, level) {
		return false
	}
	return l.queue(pending)
}

// queue hands a counted event to the writer; a full queue refuses it and counts the loss.
func (l *EventLog) queue(pending *pendingEvent) bool {
	l.queuedBytes.Add(int64(pending.bytes))
	l.queuedEvents.Add(1)
	select {
	case l.messages <- eventMessage{event: pending}:
		return true
	default:
		l.queuedBytes.Add(-int64(pending.bytes))
		l.queuedEvents.Add(-1)
		l.countLoss(ChannelOf(pending.level), pending.bytes)
		return false
	}
}

// enqueueWriterEvent queues an event that the writer reports about itself (log.policy, log.pruned) from another goroutine. These events
// pass every gate: a policy that turns a class off must still be able to say that it did.
func (l *EventLog) enqueueWriterEvent(level Level, name string, fields json.RawMessage) bool {
	// events: forwarded
	pending := writerEvent(level, name, fields)
	pending.bytes = len(fields) + len(name)
	if l.queuedBytes.Load()+int64(pending.bytes) > l.queueBytes {
		l.countLoss(ChannelOf(level), pending.bytes)
		return false
	}
	return l.queue(pending)
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
	head, _ := cutText(text, EventHeadBytes)
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

// classify gives the event the class that the catalog declares for its name. A name that the catalog does not declare is stored
// without a class and marked undeclared (docs/spec/logging.md#event).
func (e *pendingEvent) classify() {
	e.class, e.undeclared = "", false
	if class, declared := sok.EventClassOf(e.event); declared {
		e.class = class
	} else {
		e.undeclared = true
	}
}

// writerEvent is an event that the writer itself creates (log.open, log.rotated, log.dropped), with both clocks read now.
func writerEvent(level Level, event string, fields json.RawMessage) *pendingEvent {
	e := &pendingEvent{tsMicros: time.Now().UnixMicro(), monoNs: monotonicNanos(), layer: "host", level: level, event: event, fields: fields}
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
	Class    sok.Class       `json:"class,omitempty"`
	Layer    string          `json:"layer"`
	Event    string          `json:"event"`
	Cids     []string        `json:"cids,omitempty"`
	Fields   json.RawMessage `json:"fields"`
	// Undeclared is true for an event whose name the catalog does not declare; such a line has no class.
	Undeclared bool `json:"undeclared,omitempty"`
	// Truncated is the size in bytes of the fields before they were cut; it is absent for an event that was not cut.
	Truncated int `json:"truncated,omitempty"`
}

func eventLine(seq uint64, e *pendingEvent) ([]byte, error) {
	line, err := json.Marshal(eventRecord{TsMicros: e.tsMicros, MonoNs: e.monoNs, Seq: seq, Level: e.level, Class: e.class, Layer: e.layer, Event: e.event, Cids: e.cids, Fields: e.fields, Undeclared: e.undeclared, Truncated: e.truncated})
	if err != nil {
		return nil, err
	}
	return append(line, '\n'), nil
}

// logFile is one file of the writer: the main file of the channel other or the debug file of the channel debug. Only the
// goroutine of the writer uses it.
type logFile struct {
	channel Channel
	path    string
	// file is nil until the first line of the channel is written: the debug file is created when the first debug or trace
	// event arrives, so a run that stores no such event leaves no empty file.
	file *os.File
	// size is the number of bytes of the current file, written or waiting in the batch.
	size int64
	// generation is the number of the last generation that rotation closed; 0 before the first rotation.
	generation int
	batch      []byte
}

func openLogFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY|syscall.O_CLOEXEC, 0o600)
}

// rotate closes the full file of f as the next generation (`<path>.<n>`, with n counted from 1 in the order of the rotations),
// opens a new file at the path, and moves the index file with the closed generation (docs/spec/logging.md#index). No generation
// is removed or renamed. It returns the number of the generation and true; when a step fails the failure is reported, the files
// are as they were, and the writer keeps the file it has.
func (l *EventLog) rotate(f *logFile) (int, bool) {
	n := f.generation + 1
	var next *os.File
	err := sok.RotateLogIndexes(f.path, n, func() error {
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
	files := [channelCount]*logFile{
		ChannelOther: {channel: ChannelOther, path: l.path, file: main},
		ChannelDebug: {channel: ChannelDebug, path: l.debugPath},
	}
	defer func() {
		for _, f := range files {
			if f.file != nil {
				f.file.Close()
			}
		}
	}()
	var seq uint64
	// prune runs the retention (log_retention.go) and stores the event log.pruned; rotatedFile says that the push that is running
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
	appendLine := func(f *logFile, e *pendingEvent) {
		seq++
		line, err := eventLine(seq, e)
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
		f.batch = append(f.batch, line...)
		f.size += int64(len(line))
	}
	push := func(e *pendingEvent) {
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
			appendLine(f, writerEvent(LevelInfo, "log.open", l.openFields))
		}
		// The line is serialized with the next seq. A file that this line would take past the bound is closed first; the new
		// file opens with log.open and the record of the rotation, so every file of the contract starts with log.open and seq
		// continues.
		line, err := eventLine(seq+1, e)
		if err == nil && f.size > 0 && f.size+int64(len(line)) > l.rotateBytes {
			flushFile(f)
			full := f.size
			if n, rotated := l.rotate(f); rotated {
				f.generation = n
				f.size = 0
				appendLine(f, writerEvent(LevelInfo, "log.open", l.openFields))
				appendLine(f, writerEvent(LevelInfo, "log.rotated", json.RawMessage(fmt.Sprintf(`{"bytes":%d,"generation":%d}`, full, n))))
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
		// The pass counts what is on disk; the batch that waits for the interval is not in it, which is at most one batch.
		result, err := pruneRuns(l.directory, l.runName, l.retention)
		if err != nil {
			fmt.Fprintf(os.Stderr, "event writer: retention: %v\n", err)
		}
		if result.files == 0 && result.remaining <= l.retention {
			return
		}
		level := LevelInfo
		if result.remaining > l.retention {
			level = LevelWarn
		}
		push(writerEvent(level, "log.pruned", result.fields(l.retention)))
	}
	push(open)
	prune()
	// dropped stores one log.dropped after the range of seq that the refused events would have had; channel is the channel of the
	// refused events.
	dropped := func(events, bytes uint64, reason string, channel Channel) {
		if events == 0 {
			return
		}
		// The refused events had no seq. Their numbers are skipped, and log.dropped is stored after the range that it
		// names (docs/spec/logging.md#event).
		from := seq + 1
		seq += events
		// The fields are numbers and fixed texts, so they are written as text without a serializer that can fail.
		fields := json.RawMessage(fmt.Sprintf(`{"from_seq":%d,"to_seq":%d,"count":%d,"bytes":%d,"reason":%q,"channel":%q}`,
			from, seq, events, bytes, reason, channel.String()))
		push(writerEvent(LevelWarn, "log.dropped", fields))
	}
	// pullNative takes the records of the native ring. No event source reaches the writer from there: a native thread
	// must not call into Go, so the writer pulls at its batch interval and when it flushes.
	var pulled []byte
	pullNative := func() {
		if l.pull == nil {
			return
		}
		if pulled == nil {
			pulled = make([]byte, nativePullBytes)
		}
		var refused, refusedBytes uint64
		for pass := 0; pass < nativePullPasses; pass++ {
			n, err := l.pull(pulled)
			if err != nil {
				fmt.Fprintf(os.Stderr, "event writer: the pull of the native ring failed: %v\n", err)
				break
			}
			if n == 0 {
				break
			}
			for offset := 0; offset < n; {
				length, event, err := nativeEventOf(pulled[offset:n])
				if err != nil {
					// The rest of the buffer cannot be located after a record whose length is wrong.
					fmt.Fprintf(os.Stderr, "event writer: a native record was refused: %v\n", err)
					refused++
					refusedBytes += uint64(n - offset)
					if length == 0 {
						break
					}
				} else {
					push(event)
				}
				offset += length
			}
		}
		// A record that cannot be decoded has no level, so its loss is counted in the channel other.
		dropped(refused, refusedBytes, "a native record was refused", ChannelOther)
		if l.pullLoss != nil {
			for channel := Channel(0); channel < channelCount; channel++ {
				events, bytes := l.pullLoss(channel)
				dropped(events, bytes, "the native ring was full", channel)
			}
		}
	}
	recordLoss := func() {
		for channel := Channel(0); channel < channelCount; channel++ {
			events := l.lost[channel].events.Swap(0)
			dropped(events, l.lost[channel].bytes.Swap(0), "the queue was full", channel)
		}
		// The events that the gate refused are reported with the exact count for each class and level.
		for c, class := range sok.Classes {
			for i, level := range levelNames {
				if count := l.gate.gated[c][i].Swap(0); count > 0 {
					push(writerEvent(LevelInfo, "log.gated", json.RawMessage(fmt.Sprintf(`{"class":%q,"level":%q,"count":%d}`, class, level, count))))
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
		pullNative()
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
			pullNative()
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

// nativePullBytes is the size of the buffer of one pull; nativePullPasses bounds the passes of one pull, so a flood of
// native events cannot hold the writer; the records left in the ring wait for the next pull.
const (
	nativePullBytes  = 256 << 10
	nativePullPasses = 64
)

// nativeLevels maps the level byte of a native record to the level of the contract.
var nativeLevels = []Level{LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace}

// nativeHeaderBytes is the size of the fixed part of a native record (native/darwin/src/event_ring.h).
const nativeHeaderBytes = 21

// nativeEventOf decodes the record at the start of buffer: a 4-byte length, then the wall clock in microseconds (8 bytes),
// the monotonic clock in nanoseconds (8), the level (1 byte), the class (1 byte), the length of the name (1 byte), the length of
// the cids (2 bytes), the name, the cids as a list separated by commas and the fields as JSON text, in the byte order of the
// host. It returns the number of bytes the record takes. When the length itself is wrong it returns 0, so the caller
// abandons the rest of the buffer. The class that the library gave is checked against the catalog: a record of a declared
// event with another class is refused, so a producer that disagrees with the catalog is counted and reported.
func nativeEventOf(buffer []byte) (int, *pendingEvent, error) {
	if len(buffer) < 4 {
		return 0, nil, fmt.Errorf("%d bytes are left, which is less than a length", len(buffer))
	}
	length := int(binary.NativeEndian.Uint32(buffer))
	if length < nativeHeaderBytes || 4+length > len(buffer) {
		return 0, nil, fmt.Errorf("the length %d does not fit %d bytes", length, len(buffer)-4)
	}
	total := 4 + length
	body := buffer[4:total]
	level := int(body[16])
	class := int(body[17])
	nameLength := int(body[18])
	cidsLength := int(binary.NativeEndian.Uint16(body[19:]))
	if level >= len(nativeLevels) {
		return total, nil, fmt.Errorf("the level %d is not defined", level)
	}
	if class >= len(sok.Classes) {
		return total, nil, fmt.Errorf("the class %d is not defined", class)
	}
	if nativeHeaderBytes+nameLength+cidsLength > len(body) {
		return total, nil, fmt.Errorf("the name of %d bytes and the cids of %d bytes do not fit the record", nameLength, cidsLength)
	}
	name := string(body[nativeHeaderBytes : nativeHeaderBytes+nameLength])
	if !strings.HasPrefix(name, "native.") {
		return total, nil, fmt.Errorf("the event %q does not start with its layer \"native\"", name)
	}
	mono := binary.NativeEndian.Uint64(body[8:])
	if mono == 0 {
		return total, nil, fmt.Errorf("the monotonic clock of %s is 0", name)
	}
	var cids []string
	if cidsLength > 0 {
		cids = strings.Split(string(body[nativeHeaderBytes+nameLength:nativeHeaderBytes+nameLength+cidsLength]), ",")
		if err := checkCids(cids); err != nil {
			return total, nil, fmt.Errorf("the cids of %s: %w", name, err)
		}
	}
	fields := body[nativeHeaderBytes+nameLength+cidsLength:]
	if !json.Valid(fields) || len(fields) == 0 || fields[0] != '{' {
		return total, nil, fmt.Errorf("the fields of %s are not a JSON object", name)
	}
	event := &pendingEvent{tsMicros: int64(binary.NativeEndian.Uint64(body)), monoNs: mono, cids: cids, layer: "native", level: nativeLevels[level],
		event: name, fields: append(json.RawMessage(nil), fields...)}
	event.classify()
	if !event.undeclared && event.class != sok.Classes[class] {
		return total, nil, fmt.Errorf("the record of %s has the class %s, and the catalog declares %s", name, sok.Classes[class], event.class)
	}
	return total, event, nil
}
