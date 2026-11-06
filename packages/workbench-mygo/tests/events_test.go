// The events of the workbench leave through the host call log in the batches of docs/spec/logging.md#writers: each names the start
// of the workbench, carries the clocks of the host, and passes the gate of the policy in force.
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	sok "github.com/soksak-app/core/packages/sok/go/src"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The clocks of the fixture host differ from the clock of the workbench by these amounts.
const (
	hostWallOffset = 5 * time.Second
	hostMonoStart  = 90 * time.Second
)

// writerHost is the host call log of one window with a clock that the test moves.
type writerHost struct {
	mu       sync.Mutex
	now      time.Time
	epoch    time.Time
	trips    []time.Duration
	requests []map[string]any
	refused  map[string]error
	classes  map[string]string
	// hold keeps a batch request in flight until it closes.
	hold chan struct{}
}

func (h *writerHost) clock() time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.now
}

func (h *writerHost) pass(elapsed time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.now = h.now.Add(elapsed)
}

// log answers a request. A clock request reads the clocks of the host in the middle of its round trip.
func (h *writerHost) log(_ context.Context, argument json.RawMessage) (any, error) {
	var request map[string]any
	if err := json.Unmarshal(argument, &request); err != nil {
		return nil, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.requests = append(h.requests, request)
	action, _ := request["action"].(string)
	if action == "batch" && h.hold != nil {
		h.mu.Unlock()
		<-h.hold
		h.mu.Lock()
	}
	if err := h.refused[action]; err != nil {
		return nil, err
	}
	switch action {
	case "clock":
		trip := time.Millisecond
		if len(h.trips) > 0 {
			trip, h.trips = h.trips[0], h.trips[1:]
		}
		h.now = h.now.Add(trip / 2)
		reading := &host.ClockReading{TsMicros: h.now.Add(hostWallOffset).UnixMicro(), MonoNs: uint64(h.now.Sub(h.epoch) + hostMonoStart)}
		h.now = h.now.Add(trip - trip/2)
		return reading, nil
	case "policy-read":
		return map[string]any{"classes": h.classes}, nil
	}
	return nil, nil
}

// batches returns the batch requests that the host received.
func (h *writerHost) batches() [][]map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	var batches [][]map[string]any
	for _, request := range h.requests {
		if request["action"] != "batch" {
			continue
		}
		var batch []map[string]any
		for _, event := range request["events"].([]any) {
			batch = append(batch, event.(map[string]any))
		}
		batches = append(batches, batch)
	}
	return batches
}

// written returns every event that the host received, in order.
func (h *writerHost) written() []map[string]any {
	var events []map[string]any
	for _, batch := range h.batches() {
		events = append(events, batch...)
	}
	return events
}

// event returns the only event named name.
func (h *writerHost) event(t *testing.T, name string) map[string]any {
	t.Helper()
	var found []map[string]any
	for _, event := range h.written() {
		if event["event"] == name {
			found = append(found, event)
		}
	}
	if len(found) != 1 {
		t.Fatalf("the host received %d events %s among %v", len(found), name, namesOf(h.written()))
	}
	return found[0]
}

func namesOf(events []map[string]any) []string {
	names := make([]string, 0, len(events))
	for _, event := range events {
		names = append(names, event["event"].(string))
	}
	return names
}

// writerFixture is a writer over writerHost, whose later steps and timers run when the test asks.
type writerFixture struct {
	t       *testing.T
	host    *writerHost
	queue   steps
	calls   *workbench.Calls
	events  *workbench.Events
	reports []string
	timers  []func()
}

func newWriter(t *testing.T, table map[string]workbench.HostCall) *writerFixture {
	t.Helper()
	epoch := time.Unix(1_800_000_000, 0)
	f := &writerFixture{t: t, host: &writerHost{now: epoch, epoch: epoch, refused: map[string]error{}, classes: sok.DefaultLogPolicy().Classes()}, queue: make(steps, 8192)}
	if table == nil {
		table = map[string]workbench.HostCall{}
	}
	table["log"] = f.host.log
	f.calls = workbench.NewCalls(table, f.queue.post)
	f.events = workbench.NewEvents(workbench.EventsOptions{
		Calls:  f.calls,
		Post:   f.queue.post,
		Report: func(line string) { f.reports = append(f.reports, line) },
		Now:    f.host.clock,
		After:  func(_ time.Duration, task func()) { f.timers = append(f.timers, task) },
	})
	return f
}

// sent runs the steps until every queued event has left.
func (f *writerFixture) sent() {
	f.t.Helper()
	ended := false
	f.events.Flush(func() { ended = true })
	f.queue.until(f.t, func() bool { return ended })
}

// begin starts the writer and runs the steps until its policy is in force.
func (f *writerFixture) begin() {
	f.t.Helper()
	ready := false
	f.events.Begin(func() { ready = true })
	f.queue.until(f.t, func() bool { return ready })
}

// call makes a host call and runs the steps until its event has left.
func (f *writerFixture) call(name string, argument any) {
	f.t.Helper()
	answered := false
	f.calls.Call(name, argument, func(any, error) { answered = true })
	f.queue.until(f.t, func() bool { return answered })
	f.sent()
}

// follow puts the policy in force that stores classes at level.
func (f *writerFixture) follow(level string) {
	f.t.Helper()
	classes := map[string]any{}
	for name := range f.host.classes {
		classes[name] = level
	}
	f.events.Follow(map[string]any{"classes": classes})
}

func TestTheStartOfTheWorkbenchLeavesAfterTheClockStatement(t *testing.T) {
	f := newWriter(t, nil)
	f.begin()
	f.sent()
	written := f.host.written()
	if got := namesOf(written); !reflect.DeepEqual(got, []string{"workbench.log.clock", "workbench.start"}) {
		t.Fatalf("the first batch holds %v", got)
	}
	start := written[1]
	if start["level"] != "info" || start["start"] != f.events.Start() || written[0]["start"] != f.events.Start() {
		t.Fatalf("the events name %v and %v, not the start %s", written[0], start, f.events.Start())
	}
	if len(f.events.Start()) != 36 || strings.Count(f.events.Start(), "-") != 4 {
		t.Fatalf("the start %q is not a UUID", f.events.Start())
	}
	fields := start["fields"].(map[string]any)
	if fields["started_at"] != float64(f.host.epoch.UnixMilli()) || fields["url"] != "mygo://workbench" {
		t.Fatalf("workbench.start has the fields %v", fields)
	}
	if other := newWriter(t, nil); other.events.Start() == f.events.Start() {
		t.Fatal("two starts drew one identity")
	}
	if len(f.reports) > 0 {
		t.Fatalf("the writer reported %q", f.reports)
	}
}

func TestEveryEventCarriesTheClocksOfTheHost(t *testing.T) {
	f := newWriter(t, nil)
	f.host.trips = []time.Duration{40 * time.Millisecond, 10 * time.Millisecond, 20 * time.Millisecond, 30 * time.Millisecond, 50 * time.Millisecond}
	f.events.Error("first: failed")
	f.host.pass(7 * time.Millisecond)
	at := f.host.clock()
	f.events.Error("second: failed")
	f.sent()
	clocks := 0
	for _, request := range f.host.requests {
		if request["action"] == "clock" {
			clocks++
		}
	}
	if clocks != 5 {
		t.Fatalf("the writer read the clocks %d times", clocks)
	}
	statement := f.host.event(t, "workbench.log.clock")["fields"].(map[string]any)
	if statement["trip_us"] != float64(10_000) {
		t.Fatalf("the clock statement holds the round trip %v, not the shortest", statement["trip_us"])
	}
	if resolution, _ := statement["resolution_us"].(float64); resolution < 1 {
		t.Fatalf("the clock statement holds the resolution %v", statement["resolution_us"])
	}
	written := f.host.written()
	second := written[len(written)-1]
	if second["ts_us"] != float64(at.Add(hostWallOffset).UnixMicro()) {
		t.Fatalf("the event has ts_us %v, not the time of the host at its emission %d", second["ts_us"], at.Add(hostWallOffset).UnixMicro())
	}
	if second["mono_ns"] != float64(at.Sub(f.host.epoch)+hostMonoStart) {
		t.Fatalf("the event has mono_ns %v, not the time of the host at its emission %d", second["mono_ns"], at.Sub(f.host.epoch)+hostMonoStart)
	}
}

func TestTheEventsOfOneTurnLeaveInOneBatchInOrder(t *testing.T) {
	f := newWriter(t, nil)
	for _, line := range []string{"a: 1", "b: 2", "c: 3"} {
		f.events.Error(line)
	}
	f.sent()
	if got := len(f.host.batches()); got != 1 {
		t.Fatalf("the events left in %d batches", got)
	}
	var places []string
	for _, event := range f.host.written()[1:] {
		places = append(places, event["fields"].(map[string]any)["where"].(string))
	}
	if !reflect.DeepEqual(places, []string{"a", "b", "c"}) {
		t.Fatalf("the events left in the order %v", places)
	}
}

func TestABatchCarriesAtMost256EventsAndTheRestFollows(t *testing.T) {
	f := newWriter(t, nil)
	for index := range 300 {
		f.events.Error(fmt.Sprintf("place: %d", index))
	}
	f.sent()
	batches := f.host.batches()
	// The first batch adds the clock statement to the events of the queue.
	if len(batches) != 2 || len(batches[0]) != 257 || len(batches[1]) != 44 {
		sizes := make([]int, 0, len(batches))
		for _, batch := range batches {
			sizes = append(sizes, len(batch))
		}
		t.Fatalf("the batches hold %v events", sizes)
	}
}

func TestARecordSeparatesItsPlaceAndIsCutAtItsBounds(t *testing.T) {
	cases := []struct {
		name, line, where, text string
		truncated               bool
	}{
		{"a line with a place", "exposure reply: refused: twice", "exposure reply", "refused: twice", false},
		{"a line without a place", "refused", "workbench", "refused", false},
		{"a line that starts with the separator", ": refused", "workbench", ": refused", false},
		{"a place of two lines", "first\nsecond: refused", "workbench", "first\nsecond: refused", false},
		{"a long text", "place: " + strings.Repeat("가", 3000), "place", strings.Repeat("가", 2730), true},
		{"a long place", strings.Repeat("a", 2000) + ": text", strings.Repeat("a", 1024), "text", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newWriter(t, nil)
			f.events.Error(c.line)
			f.sent()
			event := f.host.event(t, "workbench.record.error")
			fields := event["fields"].(map[string]any)
			if event["level"] != "error" || fields["where"] != c.where || fields["text"] != c.text {
				t.Fatalf("the record is %v", event)
			}
			if truncated, _ := fields["truncated"].(bool); truncated != c.truncated {
				t.Fatalf("the record says truncated %v", fields["truncated"])
			}
		})
	}
}

func TestAnObservationIsARecordAtTheLevelInfo(t *testing.T) {
	f := newWriter(t, nil)
	f.follow("info")
	f.events.Info("place: seen")
	f.sent()
	event := f.host.event(t, "workbench.record.info")
	if fields := event["fields"].(map[string]any); event["level"] != "info" || fields["where"] != "place" || fields["text"] != "seen" {
		t.Fatalf("the record is %v", event)
	}
}

func TestAClosedGateStoresNoEventAndReportsItsCount(t *testing.T) {
	f := newWriter(t, nil)
	f.events.Info("place: one")
	f.events.Info("place: two")
	f.events.Error("place: three")
	f.queue.until(t, func() bool { return len(f.host.batches()) == 1 })
	if got := namesOf(f.host.written()); !reflect.DeepEqual(got, []string{"workbench.log.clock", "workbench.record.error"}) {
		t.Fatalf("the host received %v under the policy of errors", got)
	}
	if len(f.timers) != 1 {
		t.Fatalf("%d timers wait for the report of the counts", len(f.timers))
	}
	f.host.pass(time.Second)
	f.timers[0]()
	f.queue.until(t, func() bool { return len(f.host.batches()) == 2 })
	gated := f.host.event(t, "workbench.log.gated")
	if fields := gated["fields"].(map[string]any); gated["level"] != "info" || fields["class"] != "lifecycle" || fields["level"] != "info" || fields["count"] != float64(2) {
		t.Fatalf("the report of the gate is %v", gated)
	}
}

func TestTheReportOfTheCountsArmsNoTimerWhileABatchIsInFlight(t *testing.T) {
	f := newWriter(t, nil)
	f.host.hold = make(chan struct{})
	f.events.Info("place: one")
	f.host.pass(time.Second)
	f.timers[0]()
	f.queue.until(t, func() bool { return len(f.host.batches()) == 1 })
	// A second count waits while the host does not answer the first batch, and its second passes.
	f.events.Info("place: two")
	f.host.pass(time.Second)
	for ran := 1; ran < len(f.timers) && ran <= 10; ran++ {
		f.timers[ran]()
		f.queue.run()
	}
	if armed := len(f.timers); armed != 1 {
		t.Fatalf("%d timers were armed while a batch was in flight", armed-1)
	}
	// The end of the batch sends the count that is due, and then no count and no timer remain.
	close(f.host.hold)
	f.queue.until(t, func() bool { return len(f.host.batches()) == 2 })
	f.sent()
	if armed := len(f.timers); armed != 1 {
		t.Fatalf("%d timers were armed after the counts left", armed-1)
	}
}

func TestACountRefusedWhileABatchIsInFlightWaitsForTheRestOfItsInterval(t *testing.T) {
	f := newWriter(t, nil)
	f.host.hold = make(chan struct{})
	f.events.Info("place: one")
	f.host.pass(time.Second)
	f.timers[0]()
	f.queue.until(t, func() bool { return len(f.host.batches()) == 1 })
	f.events.Info("place: two")
	f.host.pass(400 * time.Millisecond)
	close(f.host.hold)
	f.queue.until(t, func() bool { return len(f.timers) == 2 })
	if batches := len(f.host.batches()); batches != 1 {
		t.Fatalf("the count left in batch %d before its interval ended", batches)
	}
	f.host.pass(600 * time.Millisecond)
	f.timers[1]()
	f.queue.until(t, func() bool { return len(f.host.batches()) == 2 })
}

func TestThePolicyInForceOfTheHostOpensTheGate(t *testing.T) {
	f := newWriter(t, nil)
	f.host.classes = map[string]string{}
	for class := range sok.DefaultLogPolicy().Classes() {
		f.host.classes[class] = "info"
	}
	f.begin()
	f.sent()
	f.events.Info("place: seen")
	f.sent()
	f.host.event(t, "workbench.record.info")
	f.follow("error")
	f.events.Info("place: gated")
	f.sent()
	f.host.event(t, "workbench.record.info")
}

func TestARefusedPolicyLeavesThePolicyInForce(t *testing.T) {
	f := newWriter(t, nil)
	f.follow("info")
	f.events.Follow(map[string]any{"classes": map[string]any{"call": "loud"}})
	f.events.Info("place: seen")
	f.sent()
	f.host.event(t, "workbench.record.info")
	if len(f.reports) != 1 || !strings.HasPrefix(f.reports[0], "log policy: ") {
		t.Fatalf("the writer reported %q", f.reports)
	}
}

func TestAPolicyThatCannotBeReadIsReported(t *testing.T) {
	f := newWriter(t, nil)
	f.host.refused["policy-read"] = errors.New("no writer")
	f.begin()
	f.sent()
	if len(f.reports) != 1 || f.reports[0] != "log policy: no writer" {
		t.Fatalf("the writer reported %q", f.reports)
	}
}

func TestAFullQueueRefusesTheNewestEventsAndReportsThem(t *testing.T) {
	f := newWriter(t, nil)
	for range 4098 {
		f.events.Error("place: lost")
	}
	f.sent()
	dropped := f.host.event(t, "workbench.log.dropped")
	fields := dropped["fields"].(map[string]any)
	if dropped["level"] != "warn" || fields["count"] != float64(2) || fields["reason"] != "the workbench queue was full" {
		t.Fatalf("the report of the loss is %v", dropped)
	}
	if bytes, _ := fields["bytes"].(float64); bytes <= 0 {
		t.Fatalf("the report of the loss counts %v bytes", fields["bytes"])
	}
}

func TestAQueueOverItsBytesRefusesTheEvent(t *testing.T) {
	f := newWriter(t, nil)
	for range 73 {
		f.events.Emit("error", "workbench.record.error", func() map[string]any { return map[string]any{"text": strings.Repeat("x", 60000)} }, nil)
	}
	f.sent()
	fields := f.host.event(t, "workbench.log.dropped")["fields"].(map[string]any)
	if fields["reason"] != "the workbench queue reached 4194304 bytes" || fields["count"] != float64(4) {
		t.Fatalf("the report of the loss is %v", fields)
	}
}

func TestFieldsOverTheBoundBecomeTheirHead(t *testing.T) {
	f := newWriter(t, nil)
	f.events.Emit("error", "workbench.record.error", func() map[string]any { return map[string]any{"text": strings.Repeat("x", 70000)} }, nil)
	f.sent()
	if len(f.reports) > 0 {
		t.Fatalf("the writer reported %q", f.reports)
	}
	fields := f.host.event(t, "workbench.record.error")["fields"].(map[string]any)
	head, _ := fields["head"].(string)
	if fields["truncated"] != true || len(head) != 4096 || !strings.HasPrefix(head, `{"text":"xxx`) {
		t.Fatalf("the fields are %d bytes of head and truncated %v", len(head), fields["truncated"])
	}
}

func TestFieldsThatJSONCannotCarryAreReported(t *testing.T) {
	f := newWriter(t, nil)
	f.events.Emit("error", "workbench.record.error", func() map[string]any { return map[string]any{"text": func() {}} }, nil)
	f.sent()
	if len(f.host.written()) != 0 || len(f.reports) != 1 || !strings.HasPrefix(f.reports[0], "event workbench.record.error: ") {
		t.Fatalf("the host received %v and the writer reported %q", f.host.written(), f.reports)
	}
}

func TestRefusedCorrelationIdentifiersLeaveTheEventWithoutThem(t *testing.T) {
	f := newWriter(t, nil)
	f.events.Emit("error", "workbench.record.error", func() map[string]any { return map[string]any{} }, []string{`"quoted`})
	f.sent()
	if _, carries := f.host.event(t, "workbench.record.error")["cids"]; carries {
		t.Fatal("the event carries the refused identifiers")
	}
	if len(f.reports) != 1 || !strings.HasPrefix(f.reports[0], "event workbench.record.error: ") {
		t.Fatalf("the writer reported %q", f.reports)
	}
}

func TestAFailedBatchIsReportedAndTheNextEventsLeave(t *testing.T) {
	f := newWriter(t, nil)
	f.host.refused["batch"] = errors.New("the writer stopped")
	f.events.Error("place: first")
	f.sent()
	if len(f.reports) != 1 || f.reports[0] != "event batch of 2 events failed: the writer stopped" {
		t.Fatalf("the writer reported %q", f.reports)
	}
	delete(f.host.refused, "batch")
	f.events.Error("place: second")
	f.sent()
	if got := len(f.host.batches()); got != 2 {
		t.Fatalf("the host received %d batches", got)
	}
}

func TestAClockAnswerWithoutTheClocksFailsTheBatch(t *testing.T) {
	f := newWriter(t, nil)
	f.host.refused["clock"] = errors.New("no clock")
	f.events.Error("place: first")
	f.sent()
	if len(f.reports) != 1 || f.reports[0] != "event batch of 1 events failed: no clock" {
		t.Fatalf("the writer reported %q", f.reports)
	}
}

func TestFlushEndsAfterTheBatchThatCarriesTheEvents(t *testing.T) {
	f := newWriter(t, nil)
	f.events.Error("place: first")
	f.queue.run() // The send of the turn, which waits for the clocks.
	f.events.Error("place: second")
	flushed := 0
	f.events.Flush(func() { flushed = len(f.host.written()) })
	f.queue.until(t, func() bool { return flushed != 0 })
	if flushed != 3 {
		t.Fatalf("the flush ended after %d of 3 events", flushed)
	}
}

func TestFlushEndsWithNothingToSend(t *testing.T) {
	f := newWriter(t, nil)
	ended := false
	f.events.Flush(func() { ended = true })
	if !ended {
		t.Fatal("the flush of an empty queue did not end")
	}
}

func TestFlushReportsTheCountsOfTheGate(t *testing.T) {
	f := newWriter(t, nil)
	f.events.Info("place: gated")
	f.events.Flush(func() {})
	f.sent()
	f.host.event(t, "workbench.log.gated")
}

func TestAnEndedWriterSendsNothing(t *testing.T) {
	f := newWriter(t, nil)
	f.events.Error("place: queued")
	f.events.Info("place: gated")
	f.events.End()
	f.events.Error("place: late")
	f.queue.drain(t)
	f.host.pass(time.Second)
	for _, timer := range f.timers {
		timer()
	}
	f.queue.drain(t)
	if len(f.host.requests) != 0 || len(f.reports) != 0 {
		t.Fatalf("the host received %v and the writer reported %q", f.host.requests, f.reports)
	}
}

func TestABatchInFlightWhenTheWriterEndsIsNotAFailure(t *testing.T) {
	f := newWriter(t, nil)
	f.host.refused["batch"] = errors.New("the main window is gone")
	f.host.hold = make(chan struct{})
	f.events.Error("place: first")
	f.queue.until(t, func() bool { return len(f.host.batches()) == 1 })
	f.events.End()
	close(f.host.hold)
	f.queue.drain(t)
	if len(f.reports) != 0 {
		t.Fatalf("the writer reported %q", f.reports)
	}
}

func TestTheClosedWindowEndsItsWriter(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.until(t, func() bool { return stored.called("windowReady") })
	queue.drain(t)
	stored.failing = map[string]error{"log": errors.New("the main window is gone")}
	app.Close(window)
	queue.drain(t)
}

func TestAHostCallIsRecorded(t *testing.T) {
	f := newWriter(t, map[string]workbench.HostCall{
		"windowReady": func(context.Context, json.RawMessage) (any, error) { return nil, nil },
		"workspace":   func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("no store") },
		"performance": func(context.Context, json.RawMessage) (any, error) { return nil, nil },
	})
	f.calls.Observe(f.events.Call)
	f.follow("debug")
	f.call("windowReady", nil)
	event := f.host.event(t, "workbench.call")
	fields := event["fields"].(map[string]any)
	if event["level"] != "debug" || fields["name"] != "windowReady" || fields["args"] != "[]" || fields["ok"] != true || fields["truncated"] != false {
		t.Fatalf("the call is %v", event)
	}
	if _, present := fields["micros"].(float64); !present {
		t.Fatalf("the call has no time: %v", fields)
	}
	if _, present := fields["error"]; present {
		t.Fatalf("a call that succeeded has an error: %v", fields)
	}
	f.host.requests = nil
	f.call("performance", map[string]bool{"on": true})
	if len(f.host.written()) != 0 {
		t.Fatalf("the call performance was recorded: %v", f.host.written())
	}
	f.call("workspace", map[string]string{"kind": "snapshot", "text": strings.Repeat("x", 2000)})
	event = f.host.event(t, "workbench.call")
	fields = event["fields"].(map[string]any)
	if event["level"] != "warn" || fields["ok"] != false || fields["error"] != "-32603: no store" || fields["truncated"] != true {
		t.Fatalf("the refused call is %v", event)
	}
	if args := fields["args"].(string); len(args) != 1024 || !strings.HasPrefix(args, `[{"kind":"snapshot"`) {
		t.Fatalf("the arguments are %d bytes: %s", len(args), args)
	}
}

func TestTheLogCallIsNotRecorded(t *testing.T) {
	f := newWriter(t, nil)
	f.calls.Observe(f.events.Call)
	f.follow("trace")
	f.events.Error("place: first")
	f.sent()
	if got := namesOf(f.host.written()); !reflect.DeepEqual(got, []string{"workbench.log.clock", "workbench.record.error"}) {
		t.Fatalf("the log calls recorded themselves: %v", got)
	}
}

func TestACallStatesTheCodeOfItsRefusal(t *testing.T) {
	f := newWriter(t, map[string]workbench.HostCall{
		"windowNew": func(context.Context, json.RawMessage) (any, error) { return nil, workbench.Refuse(1003, "no window") },
	})
	f.calls.Observe(f.events.Call)
	f.follow("warn")
	f.call("windowNew", nil)
	if got := f.host.event(t, "workbench.call")["fields"].(map[string]any)["error"]; got != "1003: no window" {
		t.Fatalf("the refused call states %v", got)
	}
}

func TestASidecarSendCarriesTheIdentifiersOfItsArguments(t *testing.T) {
	f := newWriter(t, map[string]workbench.HostCall{
		"sidecarSend": func(context.Context, json.RawMessage) (any, error) { return nil, nil },
	})
	f.calls.Observe(f.events.Call)
	f.follow("debug")
	f.call("sidecarSend", map[string]any{"sidecar": "vt", "cids": []string{"op-1"}})
	f.call("sidecarSend", map[string]any{"sidecar": "vt", "cids": []string{}})
	written := f.host.written()[1:]
	if len(written) != 2 || !reflect.DeepEqual(written[0]["cids"], []any{"op-1"}) {
		t.Fatalf("the calls are %v", written)
	}
	if _, carries := written[1]["cids"]; carries {
		t.Fatalf("a call without identifiers carries them: %v", written[1])
	}
}

func TestACommandRequestIsRecorded(t *testing.T) {
	cases := []struct {
		name, params, level, failure string
		run                          func(json.RawMessage) (any, error)
	}{
		{name: "a command that answers", params: `{"name":"core.library.window","params":{}}`, level: "debug", run: func(json.RawMessage) (any, error) { return 1, nil }},
		{name: "a command that fails", params: `{"name":"core.library.window","params":{}}`, level: "warn", failure: "-32000: stored failure", run: func(json.RawMessage) (any, error) { return nil, errors.New("stored failure") }},
		{name: "a refusal keeps its code", params: `{"name":"core.library.window","params":{}}`, level: "warn", failure: "1002: command core.library.window is not registered"},
		{name: "a command without a declaration", params: `{"name":"core.unknown","params":{}}`, level: "warn", failure: "1001: unknown command core.unknown"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newWriter(t, nil)
			f.follow("debug")
			declared, err := workbench.Declared()
			if err != nil {
				t.Fatal(err)
			}
			registry := workbench.NewRegistry(declared)
			registry.Record(f.events.Command)
			if c.run != nil {
				registry.Command("core.library.window", c.run)
			}
			if _, err := registry.Answer("command.run", json.RawMessage(c.params), nil); (err != nil) != (c.failure != "") {
				t.Fatalf("the answer failed with %v", err)
			}
			f.sent()
			event := f.host.event(t, "workbench.command")
			fields := event["fields"].(map[string]any)
			var name struct{ Name string }
			if err := json.Unmarshal([]byte(c.params), &name); err != nil {
				t.Fatal(err)
			}
			if event["level"] != c.level || fields["name"] != name.Name || fields["ok"] != (c.failure == "") {
				t.Fatalf("the command is %v", event)
			}
			if got, _ := fields["error"].(string); got != c.failure {
				t.Fatalf("the command states %q, not %q", got, c.failure)
			}
		})
	}
}

func TestARequestThatNamesNoCommandIsNotRecorded(t *testing.T) {
	f := newWriter(t, nil)
	f.follow("debug")
	registry := workbench.NewRegistry(&workbench.Declarations{Commands: map[string]bool{}, Statuses: map[string]bool{}, Elements: map[string]bool{}})
	registry.Record(f.events.Command)
	for _, c := range [][2]string{{"command.run", `{}`}, {"status.get", `{"name":"core.test"}`}} {
		if _, err := registry.Answer(c[0], json.RawMessage(c[1]), nil); err == nil {
			t.Fatalf("%s %s was answered", c[0], c[1])
		}
	}
	f.sent()
	if len(f.host.written()) != 0 {
		t.Fatalf("the host received %v", f.host.written())
	}
}

func TestTheWriterOfTheHostStoresTheEvents(t *testing.T) {
	log, err := host.StartEventLog(host.EventLogOptions{Directory: t.TempDir(), Role: "host", Boot: "test", QueueEvents: 1024, QueueBytes: 1 << 20, BatchInterval: time.Millisecond, RotateBytes: 1 << 24, RetentionBytes: 1 << 26})
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	policy, err := host.ParseLogPolicy("every level", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
	f := newWriter(t, nil)
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"windowReady": func(context.Context, json.RawMessage) (any, error) { return nil, nil },
		"log": func(_ context.Context, argument json.RawMessage) (any, error) {
			var request map[string]any
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			reply, err := host.LogCommand(log, request)
			if err != nil {
				return nil, err
			}
			if reply.Clock != nil {
				return reply.Clock, nil
			}
			return map[string]any{"classes": reply.Classes}, nil
		},
	}, f.queue.post)
	events := workbench.NewEvents(workbench.EventsOptions{Calls: calls, Post: f.queue.post, Report: func(line string) { t.Errorf("the writer reported %s", line) }, Now: time.Now,
		After: func(time.Duration, func()) {}})
	calls.Observe(events.Call)
	ready, answered, ended := false, false, false
	events.Begin(func() { ready = true })
	f.queue.until(t, func() bool { return ready })
	events.Follow(map[string]any{"classes": traceClasses()})
	events.Error("place: failed")
	calls.Call("windowReady", nil, func(any, error) { answered = true })
	f.queue.until(t, func() bool { return answered })
	events.Command("core.test", time.Millisecond, nil)
	events.Flush(func() { ended = true })
	f.queue.until(t, func() bool { return ended })
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, file := range []string{log.Path(), strings.TrimSuffix(log.Path(), ".jsonl") + ".debug.jsonl"} {
		text, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, strings.Split(string(text), "\n")...)
	}
	stored := map[string]map[string]any{}
	for _, line := range lines {
		var event map[string]any
		if json.Unmarshal([]byte(line), &event) == nil {
			if name, _ := event["event"].(string); strings.HasPrefix(name, "workbench.") {
				stored[name] = event
			}
		}
	}
	for _, name := range []string{"workbench.start", "workbench.log.clock", "workbench.record.error", "workbench.call", "workbench.command"} {
		if event := stored[name]; event == nil || event["start"] != events.Start() || event["layer"] != "workbench" {
			t.Errorf("the writer stored %v as %s, among %d lines", event, name, len(lines))
		}
	}
}

// traceClasses names every class at the level trace.
func traceClasses() map[string]any {
	classes := map[string]any{}
	for class := range sok.DefaultLogPolicy().Classes() {
		classes[class] = "trace"
	}
	return classes
}

func TestTheShellWritesItsEventsThroughTheHostCallLog(t *testing.T) {
	stored := &storedHost{classes: traceClasses(), common: map[string]any{"diagnostics.log": traceClasses()}}
	f := newShell(t, stored)
	if got := stored.written("workbench.start"); len(got) != 1 {
		t.Fatalf("the host received %v", got)
	}
	var called []string
	for _, event := range stored.written("workbench.call") {
		called = append(called, event["fields"].(map[string]any)["name"].(string))
	}
	if strings.Join(startCalls(called), " ") != "workspace windowReady notificationState pluginsState sidecarsOutdated sidecarsRetain" {
		t.Fatalf("the shell recorded the calls %v", called)
	}
	if _, err := f.shell.Registry().Answer("command.run", json.RawMessage(`{"name":"core.unknown","params":{}}`), nil); err == nil {
		t.Fatal("the unknown command was answered")
	}
	f.pending.until(t, func() bool { return len(stored.written("workbench.command")) == 1 })
}

func TestAShownErrorIsAWorkbenchRecord(t *testing.T) {
	stored := &storedHost{failing: map[string]error{"workspace": errors.New("no store")}}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.until(t, func() bool { return len(stored.written("workbench.record.error")) == 1 })
	record := stored.written("workbench.record.error")[0]
	if fields := record["fields"].(map[string]any); fields["where"] != "workbench" || fields["text"] != "no store" {
		t.Fatalf("the record is %v", record)
	}
}

func TestTheHostEventLogPolicyReachesTheWriter(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.until(t, func() bool { return len(stored.written("workbench.start")) == 1 })
	queue.drain(t)
	app.Emit(window, "log-policy", map[string]any{"classes": traceClasses()})
	app.Emit(window, "exposure-request", map[string]any{"id": 7, "method": "command.run", "params": json.RawMessage(`{"name":"core.unknown","params":{}}`)})
	queue.until(t, func() bool { return len(stored.written("workbench.command")) == 1 })
}

func TestTheCloseOfTheWindowWaitsForTheQueuedEvents(t *testing.T) {
	stored := &storedHost{batchCalls: true}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	app.Emit(window, "project-close-request")
	queue.until(t, func() bool { return stored.called("windowClose") })
	if !stored.called("log") {
		t.Fatal("the window closed before its events left")
	}
}

// A command that the menu, a control, a view or a shortcut runs is recorded as a request command.run is, once: the page answers
// every run of a command through command.run (docs/spec/logging.md#entrances).
func TestEveryRunOfACommandIsRecordedOnce(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	registry := workbench.NewRegistry(declared)
	var recorded []string
	registry.Record(func(name string, _ time.Duration, failure error) {
		recorded = append(recorded, fmt.Sprintf("%s %v", name, failure))
	})
	registry.Command("core.library.window", func(json.RawMessage) (any, error) { return 1, nil })
	registry.CommandLater("core.projects.browse", func(_ json.RawMessage, answer func(any, error)) {
		answer(nil, errors.New("stored failure"))
	})
	answered := 0
	registry.RunLater("core.library.window", nil, func(any, error) { answered++ })
	registry.RunLater("core.projects.browse", nil, func(any, error) { answered++ })
	if _, err := registry.Run("core.library.window", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Answer("command.run", json.RawMessage(`{"name":"core.library.window","params":{}}`), nil); err != nil {
		t.Fatal(err)
	}
	want := []string{"core.library.window <nil>", "core.projects.browse stored failure", "core.library.window <nil>", "core.library.window <nil>"}
	if answered != 2 || !reflect.DeepEqual(recorded, want) {
		t.Fatalf("the runs answered %d times and recorded %q, want 2 answers and %q", answered, recorded, want)
	}
}
