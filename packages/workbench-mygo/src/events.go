package workbench

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// The bounds of the writer, which are those of the page (docs/spec/logging.md#bounds).
const (
	eventQueueEvents   = 4096
	eventQueueBytes    = 4 * 1024 * 1024
	eventBatchEvents   = 256
	eventFieldsBytes   = 65536
	eventHeadBytes     = 4096
	eventOverheadBytes = 64
	recordWhereBytes   = 1024
	recordTextBytes    = 8192
	callArgumentsBytes = 1024
)

const (
	// clockSamples is the number of clock requests that anchor the writer to the clocks of the host.
	clockSamples = 5
	// clockStepReadings is the most readings that the measurement of the resolution of the clock takes.
	clockStepReadings = 100_000
	// gatedReportInterval is the time between two reports of the counts of the gate (docs/spec/logging.md#policy).
	gatedReportInterval = time.Second
	// internalFailure is the code of a host call that failed without a code of its own (docs/spec/logging.md#result-form).
	internalFailure = -32603
	// workbenchURL is the field url of workbench.start: the workbench of mygo is no document and names itself.
	workbenchURL = "mygo://workbench"
)

// unrecordedCalls are the host calls that are not the event workbench.call, as in packages/workbench/page-log.js: a recorded log
// call would record itself, and the others feed a view that follows the event file.
var unrecordedCalls = map[string]bool{"log": true, "performance": true, "logQuery": true, "overlayUpdate": true, "overlayPlace": true}

// EventsOptions is what the writer of a window needs.
type EventsOptions struct {
	// Calls runs the host call log.
	Calls *Calls
	// Post runs a task as a later step of the main thread.
	Post func(task func())
	// Report writes a failure of the writer itself, which cannot leave through the writer.
	Report func(line string)
	// Now reads the clock of the workbench.
	Now func() time.Time
	// After runs a task once after a delay, on any thread.
	After func(delay time.Duration, task func())
}

// queuedEvent is one event with the reading of the clock at its emission.
type queuedEvent struct {
	at     time.Time
	level  sok.Level
	event  string
	fields json.RawMessage
	cids   []string
	charge int
}

// eventLoss counts the events that one bound refused.
type eventLoss struct {
	reason       string
	count, bytes int
}

// gatedCount counts the events of a class and a level that the gate refused.
type gatedCount struct {
	class sok.Class
	level sok.Level
	count int
}

// eventClock anchors the clock of the workbench to the clocks of the host: the middle of the shortest round trip of a clock request
// is the moment of its reading.
type eventClock struct {
	at               time.Time
	trip             time.Duration
	tsMicros         int64
	monoNs           uint64
	resolutionMicros int64
	stated           bool
}

// Events is the event writer of the workbench of one window, which docs/spec/logging.md#writers states for the page: events queue
// without waiting, the events of one step leave in one call of log, and one call is in flight at a time so the host receives them in
// order. Every method runs on the main thread.
type Events struct {
	options   EventsOptions
	start     string
	startedAt time.Time
	policy    sok.LogPolicy

	queue      []queuedEvent
	queueBytes int
	lost       []eventLoss
	gated      []gatedCount
	gatedAt    time.Time
	gatedTimer bool
	scheduled  bool
	sending    bool
	anchor     *eventClock
	flushes    []func()
	// operations counts the operations that this start of the workbench began.
	operations int
	ended      bool
}

// NewEvents returns the writer of one start of the workbench, whose gate stores only errors until the policy of the host arrives.
func NewEvents(options EventsOptions) *Events {
	started := options.Now()
	return &Events{options: options, start: newStart(), startedAt: started, policy: sok.DefaultLogPolicy(), gatedAt: started}
}

// newStart draws the identity of a start of the workbench, a UUID (docs/spec/logging.md#event).
func newStart() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err) // crypto/rand.Read ends the program itself on a platform that fails.
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[:4], raw[4:6], raw[6:8], raw[8:10], raw[10:])
}

// Start is the identity of this start of the workbench.
func (e *Events) Start() string { return e.start }

// StartedAt is the time of this start of the workbench.
func (e *Events) StartedAt() time.Time { return e.startedAt }

// Begin queues the event workbench.start, which marks this start in the timeline, reads the policy in force of the host and runs ready
// with the policy in the gate, so the calls of the start pass the gate of the policy that stores them.
func (e *Events) Begin(ready func()) {
	e.Emit(sok.LevelInfo, "workbench.start", func() map[string]any {
		return map[string]any{"started_at": float64(e.startedAt.UnixMilli()), "url": workbenchURL}
	}, nil)
	e.options.Calls.Call("log", map[string]string{"action": "policy-read"}, func(value any, err error) {
		if err != nil {
			e.options.Report(fmt.Sprintf("log policy: %v", err))
		} else {
			e.Follow(value)
		}
		ready()
	})
}

// Follow puts in force the policy {classes} of the answer of policy-read or of the host event log-policy. A policy that the contract
// refuses leaves the one in force.
func (e *Events) Follow(data ...any) {
	if len(data) != 1 {
		e.options.Report(fmt.Sprintf("log policy: the event holds %d values", len(data)))
		return
	}
	value, err := decode[struct {
		Classes map[string]string `json:"classes"`
	}](data[0])
	if err != nil {
		e.options.Report(fmt.Sprintf("log policy: %v", err))
		return
	}
	text, err := json.Marshal(map[string]any{"schema": sok.LogPolicySchema, "classes": value.Classes})
	if err != nil {
		e.options.Report(fmt.Sprintf("log policy: %v", err))
		return
	}
	policy, err := sok.ParseLogPolicy("the host", text)
	if err != nil {
		e.options.Report(fmt.Sprintf("log policy: %v", err))
		return
	}
	e.policy = policy
}

// Error stores the line `<where>: <text>` as the record of a failure.
func (e *Events) Error(line string) { e.record(sok.LevelError, line) }

// Info stores the line `<where>: <text>` as the record of a state without a failure.
func (e *Events) Info(line string) { e.record(sok.LevelInfo, line) }

// record stores a line as the event workbench.record.<level>. A line without a place has the place workbench, as recordOf of
// packages/workbench/report-record.js makes it.
func (e *Events) record(level sok.Level, line string) {
	// events: workbench.record.error, workbench.record.info
	e.Emit(level, "workbench.record."+string(level), func() map[string]any {
		place, body := workbenchErrorPlace, line
		if at := strings.Index(line, ": "); at > 0 && !strings.Contains(line[:at], "\n") {
			place, body = line[:at], line[at+2:]
		}
		where, whereCut := sok.CutText(place, recordWhereBytes)
		text, textCut := sok.CutText(body, recordTextBytes)
		fields := map[string]any{"where": where, "text": text}
		if whereCut || textCut {
			fields["truncated"] = true
		}
		return fields
	}, nil)
}

// BeginOperation starts an operation of the workbench and returns the identifiers that its host calls carry.
type BeginOperation func(event string, fields map[string]any) []string

// BeginOperation starts an operation of the workbench (docs/spec/logging.md#operation-chains): it assigns the identifier
// p<start>.<n>, stores the first event of the chain with it, and returns the identifiers that the host calls of the operation carry.
func (e *Events) BeginOperation(event string, fields map[string]any) []string {
	e.operations++
	cids := []string{fmt.Sprintf("p%s.%d", e.start, e.operations)}
	// events: workbench.plugin.operation, workbench.project.operation, workbench.settings.change, workbench.update.operation, workbench.window.operation
	e.Emit(sok.LevelInfo, event, func() map[string]any { return fields }, cids)
	return cids
}

// Call stores the event workbench.call of a host call that ended (docs/spec/logging.md#automatic-entrances): the level is debug, and
// warn for a refused call. The arguments are read only for an event that the gate stores.
func (e *Events) Call(name string, argument any, cids []string, elapsed time.Duration, failure error) {
	if unrecordedCalls[name] {
		return
	}
	if cids == nil {
		cids = callCids(name, argument)
	}
	level := sok.LevelDebug
	if failure != nil {
		level = sok.LevelWarn
	}
	e.Emit(level, "workbench.call", func() map[string]any {
		arguments := []any{}
		if argument != nil {
			arguments = append(arguments, argument)
		}
		text, cut := callText(arguments)
		fields := map[string]any{"name": name, "args": text, "truncated": cut, "micros": elapsed.Microseconds(), "ok": failure == nil}
		if failure != nil {
			fields["error"] = failureText(failure, internalFailure)
		}
		return fields
	}, cids)
}

// callText is the JSON text of the arguments of a host call, cut at its bound, and whether it was cut.
func callText(arguments []any) (string, bool) {
	text, produced, err := sok.BoundedMarshal(arguments, callArgumentsBytes)
	if err != nil {
		return fmt.Sprintf("unserializable: %v", err), false
	}
	cut, _ := sok.CutText(text, callArgumentsBytes)
	return cut, produced > 0
}

// callCids are the correlation identifiers that a host call continues: only the send of a request to a sidecar carries them.
func callCids(name string, argument any) []string {
	if name != "sidecarSend" {
		return nil
	}
	// silent: arguments that are not an object carry no identifiers, and the host refuses the call itself.
	carried, _ := decode[struct {
		Cids []string `json:"cids"`
	}](argument)
	return carried.Cids
}

// Command stores the event workbench.command of a command request that ended (docs/spec/logging.md#automatic-entrances).
func (e *Events) Command(name string, elapsed time.Duration, failure error) {
	level := sok.LevelDebug
	if failure != nil {
		level = sok.LevelWarn
	}
	e.Emit(level, "workbench.command", func() map[string]any {
		fields := map[string]any{"name": name, "micros": elapsed.Microseconds(), "ok": failure == nil}
		if failure != nil {
			fields["error"] = failureText(failure, Failed)
		}
		return fields
	}, nil)
}

// failureText is `<code>: <text>` of a failure (docs/spec/logging.md#result-form); fallback is the code of a failure without one.
func failureText(failure error, fallback int) string {
	var refusal *Refusal
	if errors.As(failure, &refusal) {
		return fmt.Sprintf("%d: %s", refusal.Code, refusal.Message)
	}
	return fmt.Sprintf("%d: %s", fallback, failure.Error())
}

// End ends the writer with its workbench. What is queued ends with it, as the unsent batch of a page that ended
// (docs/spec/logging.md#limits), and a batch in flight has no window left to fail for.
func (e *Events) End() {
	e.ended = true
	e.queue, e.lost, e.gated, e.flushes = nil, nil, nil, nil
}

// Emit queues an event. fields runs only for an event that the gate stores. An event that a bound refuses is counted, and the next
// batch reports the count as workbench.log.dropped; an identifier that the host would refuse is left out of the event and reported,
// so one identifier does not refuse a whole batch.
func (e *Events) Emit(level sok.Level, event string, fields func() map[string]any, cids []string) {
	if e.ended {
		return
	}
	if class, declared := sok.EventClassOf(event); declared && !sok.PassesEveryGate(event) && !e.open(class, level) {
		return
	}
	stored, bytes, err := boundedFields(fields())
	if err != nil {
		e.options.Report(fmt.Sprintf("event %s: %v", event, err))
		return
	}
	charge := bytes + len(event) + eventOverheadBytes
	if len(e.queue) >= eventQueueEvents {
		e.refuse("the workbench queue was full", charge)
		return
	}
	if e.queueBytes+charge > eventQueueBytes {
		e.refuse(fmt.Sprintf("the workbench queue reached %d bytes", eventQueueBytes), charge)
		return
	}
	if err := sok.CheckCids(cids); err != nil {
		e.options.Report(fmt.Sprintf("event %s: %v", event, err))
		cids = nil
	}
	e.queue = append(e.queue, queuedEvent{at: e.options.Now(), level: level, event: event, fields: stored, cids: cids, charge: charge})
	e.queueBytes += charge
	e.schedule()
}

// boundedFields returns the text of fields and the bytes that the queue charges. Fields over the bound become {head, truncated}.
func boundedFields(fields map[string]any) (json.RawMessage, int, error) {
	text, produced, err := sok.BoundedMarshal(fields, eventFieldsBytes)
	if err != nil {
		return nil, 0, err
	}
	if produced == 0 {
		return text, len(text), nil
	}
	head, _ := sok.CutText(text, eventHeadBytes)
	stored, err := json.Marshal(map[string]any{"head": head, "truncated": true})
	return stored, eventHeadBytes + 32, err
}

// open asks the gate and counts an event that it refuses.
func (e *Events) open(class sok.Class, level sok.Level) bool {
	if e.policy.Allows(class, level) {
		return true
	}
	for index := range e.gated {
		if e.gated[index].class == class && e.gated[index].level == level {
			e.gated[index].count++
			e.awaitGated()
			return false
		}
	}
	e.gated = append(e.gated, gatedCount{class: class, level: level, count: 1})
	e.awaitGated()
	return false
}

// refuse counts an event that a bound refused.
func (e *Events) refuse(reason string, bytes int) {
	for index := range e.lost {
		if e.lost[index].reason == reason {
			e.lost[index].count++
			e.lost[index].bytes += bytes
			e.schedule()
			return
		}
	}
	e.lost = append(e.lost, eventLoss{reason: reason, count: 1, bytes: bytes})
	e.schedule()
}

// gatedDue reports whether the counts of the gate leave with the next batch.
func (e *Events) gatedDue() bool {
	return len(e.gated) > 0 && e.options.Now().Sub(e.gatedAt) >= gatedReportInterval
}

// awaitGated waits for the end of the interval of the counts: no event marks it. A batch in flight holds no timer: the
// end of that batch sends a count that is due or waits for the rest of the interval.
func (e *Events) awaitGated() {
	if e.gatedTimer || e.sending || len(e.gated) == 0 {
		return
	}
	e.gatedTimer = true
	e.options.After(gatedReportInterval-e.options.Now().Sub(e.gatedAt), func() {
		e.options.Post(func() {
			e.gatedTimer = false
			e.send(false)
			e.awaitGated()
		})
	})
}

// schedule sends the queue in a later step, which is the end of this one.
func (e *Events) schedule() {
	if e.scheduled {
		return
	}
	e.scheduled = true
	e.options.Post(func() { e.send(false) })
}

// Flush runs done when every queued event has left, and reports the counts of the gate at once. The close of a window calls it before
// the host call that ends the window (docs/spec/logging.md#operation-chains).
func (e *Events) Flush(done func()) {
	e.flushes = append(e.flushes, done)
	e.send(true)
}

// send starts the batch of the queue, unless a batch is in flight. A batch carries at most eventBatchEvents queued events, and the
// end of its call sends the rest.
func (e *Events) send(force bool) {
	e.scheduled = false
	if e.sending || e.ended {
		return
	}
	reportGated := len(e.gated) > 0 && (force || e.gatedDue())
	if len(e.queue) == 0 && len(e.lost) == 0 && !reportGated {
		flushes := e.flushes
		e.flushes = nil
		for _, done := range flushes {
			done()
		}
		return
	}
	count := min(len(e.queue), eventBatchEvents)
	events := append([]queuedEvent{}, e.queue[:count]...)
	e.queue = e.queue[count:]
	for _, event := range events {
		e.queueBytes -= event.charge
	}
	events = append(e.ownRecords(reportGated), events...)
	e.sending = true
	e.anchored(func(err error) {
		if err != nil {
			e.batchEnded(len(events), err)
			return
		}
		if !e.anchor.stated {
			e.anchor.stated = true
			statement, statementErr := e.clockStatement()
			if statementErr != nil {
				e.batchEnded(len(events), statementErr)
				return
			}
			events = append([]queuedEvent{statement}, events...)
		}
		e.options.Calls.Call("log", map[string]any{"action": "batch", "events": e.stamped(events)}, func(_ any, err error) {
			e.batchEnded(len(events), err)
		})
	})
}

// ownRecords are the reports of the writer about itself, which pass the gate of the writer: the counts of the gate, then the losses
// in front of the events that follow them.
func (e *Events) ownRecords(reportGated bool) []queuedEvent {
	var records []queuedEvent
	own := func(level sok.Level, event string, fields map[string]any) {
		stored, _, err := boundedFields(fields)
		if err != nil {
			e.options.Report(fmt.Sprintf("event %s: %v", event, err))
			return
		}
		records = append(records, queuedEvent{at: e.options.Now(), level: level, event: event, fields: stored})
	}
	if reportGated {
		for _, count := range e.gated {
			own(sok.LevelInfo, "workbench.log.gated", map[string]any{"class": string(count.class), "level": string(count.level), "count": count.count})
		}
		e.gated = nil
		e.gatedAt = e.options.Now()
	}
	for _, loss := range e.lost {
		own(sok.LevelWarn, "workbench.log.dropped", map[string]any{"count": loss.count, "bytes": loss.bytes, "reason": loss.reason})
	}
	e.lost = nil
	return records
}

// clockStatement is the event that states the round trip of the anchor: a time of the workbench differs from the clock of the host by
// at most half of it, which a reader needs to order the events among those of the host.
func (e *Events) clockStatement() (queuedEvent, error) {
	stored, _, err := boundedFields(map[string]any{"trip_us": e.anchor.trip.Microseconds(), "resolution_us": e.anchor.resolutionMicros})
	return queuedEvent{at: e.anchor.at, level: sok.LevelInfo, event: "workbench.log.clock", fields: stored}, err
}

// batchEnded runs at the end of a batch of count events and sends what waits.
func (e *Events) batchEnded(count int, err error) {
	e.sending = false
	if err != nil && !e.ended {
		e.options.Report(fmt.Sprintf("event batch of %d events failed: %v", count, err))
	}
	e.send(len(e.flushes) > 0)
	e.awaitGated()
}

// anchored reads the clocks of the host once and then runs ready; a failed reading is read again by the next batch.
func (e *Events) anchored(ready func(err error)) {
	if e.anchor != nil {
		ready(nil)
		return
	}
	var best *eventClock
	var sample func(left int)
	sample = func(left int) {
		if left == 0 {
			best.resolutionMicros = clockResolution()
			e.anchor = best
			ready(nil)
			return
		}
		started := e.options.Now()
		e.options.Calls.Call("log", map[string]string{"action": "clock"}, func(value any, err error) {
			ended := e.options.Now()
			if err != nil {
				ready(err)
				return
			}
			reading, err := decode[struct {
				TsMicros int64  `json:"ts_us"`
				MonoNs   uint64 `json:"mono_ns"`
			}](value)
			if err != nil {
				ready(err)
				return
			}
			if reading.TsMicros <= 0 || reading.MonoNs == 0 {
				ready(fmt.Errorf("the host answered the clock request with %v", value))
				return
			}
			trip := ended.Sub(started)
			if best == nil || trip < best.trip {
				best = &eventClock{at: started.Add(trip / 2), trip: trip, tsMicros: reading.TsMicros, monoNs: reading.MonoNs}
			}
			sample(left - 1)
		})
	}
	sample(clockSamples)
}

// clockResolution is the resolution of the clock in microseconds: the first step that a bounded run of readings observes, and 1 when
// no reading advanced or the step is shorter, so the stated bound stays a bound.
func clockResolution() int64 {
	started := time.Now()
	for range clockStepReadings {
		if stepped := time.Since(started); stepped != 0 {
			return max(1, stepped.Round(time.Microsecond).Microseconds())
		}
	}
	return 1
}

// stamped is the events of a batch with the clocks of the host at their own readings, each naming this start.
func (e *Events) stamped(events []queuedEvent) []map[string]any {
	out := make([]map[string]any, 0, len(events))
	for _, event := range events {
		since := event.at.Sub(e.anchor.at)
		item := map[string]any{
			"ts_us":   e.anchor.tsMicros + since.Round(time.Microsecond).Microseconds(),
			"mono_ns": int64(e.anchor.monoNs) + since.Nanoseconds(),
			"start":   e.start,
			"level":   string(event.level),
			"event":   event.event,
			"fields":  event.fields,
		}
		if len(event.cids) > 0 {
			item["cids"] = event.cids
		}
		out = append(out, item)
	}
	return out
}
