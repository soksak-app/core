package sok

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// idleSource is a source of events that cannot call into the writer: it counts the pulls and hands over what it holds.
type idleSource struct {
	pulls atomic.Int64
	mu    sync.Mutex
	held  []string
}

func (s *idleSource) hold(event string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.held = append(s.held, event)
}

func (s *idleSource) pull(accept func(RelayedEvent), _ func(uint64, uint64, string, Channel)) {
	s.pulls.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, event := range s.held {
		accept(RelayedEvent{TsMicros: 1, MonoNs: 1, Layer: "native", Level: LevelInfo, Event: event, Fields: json.RawMessage(`{}`)})
	}
	s.held = nil
}

// idleWriter is a writer of a test with its source, its Wake and the events of its sleeps and its writes.
type idleWriter struct {
	log    *EventLog
	source *idleSource
	wake   chan struct{}
	// sleeps receives each sleep of the writer, with whether it holds a count of the gate; writes receives each batch it wrote.
	sleeps chan bool
	writes chan struct{}
}

// idleLog starts a writer with a source and the batch interval, and returns it once the writer took what its start left and
// slept. A writer that holds an interval of an hour can store nothing by the end of an interval, so a test of it shows what the
// writer does at once.
func idleLog(t *testing.T, interval time.Duration) *idleWriter {
	t.Helper()
	useEventLogFilesystemPlatform(t)
	source := &idleSource{}
	wake := make(chan struct{}, 1)
	log, err := StartEventLog(EventLogOptions{
		Directory: t.TempDir(), Role: "host", Boot: "idle", Layer: "host", Clock: func() uint64 { return 1 },
		Spawn:       func(_ string, run func()) { go run() },
		QueueEvents: 64, QueueBytes: 1 << 20, BatchInterval: interval,
		Pull: source.pull,
		Wake: wake,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.Close)
	w := &idleWriter{log: log, source: source, wake: wake, sleeps: make(chan bool, 64), writes: make(chan struct{}, 64)}
	log.SetOnSleep(func(countHeld bool) {
		select {
		case w.sleeps <- countHeld:
		default:
			t.Error("the test did not take the sleeps of the writer")
		}
	})
	w.slept(t)
	log.SetOnWrite(func(string, int64) {
		select {
		case w.writes <- struct{}{}:
		default:
			t.Error("the test did not take the writes of the writer")
		}
	})
	return w
}

// slept waits for the next sleep of the writer and returns whether it holds a count of the gate. Only an event, a Wake, a
// loss, a request or the report of a held count wakes a writer that sleeps, so what follows a sleep is what the test does.
func (w *idleWriter) slept(t *testing.T) bool {
	t.Helper()
	select {
	case countHeld := <-w.sleeps:
		return countHeld
	case <-time.After(5 * time.Second):
		t.Fatal("the writer did not sleep")
		return false
	}
}

// wrote reports the writes that the writer made and the test did not take, without waiting.
func (w *idleWriter) wrote() int {
	return len(w.writes)
}

func fileHas(t *testing.T, path, text string) bool {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return strings.Contains(string(data), text)
}

// waitForFile waits for the writes of the writer until one of them left text in the file. It takes the write that stored text,
// so a count of the writes that follow starts after it.
func (w *idleWriter) waitForFile(t *testing.T, text, what string) {
	t.Helper()
	for {
		select {
		case <-w.writes:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: %s is not stored", what, text)
		}
		if fileHas(t, w.log.Path(), text) {
			return
		}
	}
}

// A writer with nothing to write does not wake: the batch interval of the host would be ten wakeups each second of an idle
// application, which G2 of docs/spec/hosts.md does not leave room for. The start takes the source once and sleeps.
// contract: log.writer.sleeps-with-nothing-to-write
func TestWriterSleepsWithNothingToWrite(t *testing.T) {
	w := idleLog(t, 5*time.Millisecond)
	if pulls := w.source.pulls.Load(); pulls != 1 {
		t.Fatalf("the writer pulled %d times before it slept, want the one of its start", pulls)
	}
}

// One Wake takes the source at once and once at the end of the interval it starts, and the writer sleeps again.
// contract: log.writer.sleeps-with-nothing-to-write
func TestWriterSleepsAgainAfterAWake(t *testing.T) {
	w := idleLog(t, 5*time.Millisecond)
	from := w.source.pulls.Load()
	w.wake <- struct{}{}
	w.slept(t)
	if got := w.source.pulls.Load() - from; got != 2 {
		t.Fatalf("the writer pulled %d times after one Wake", got)
	}
}

// An event that wakes a writer that slept is stored at once, without an interval and without a flush.
// contract: log.writer.stores-the-first-event-at-once
func TestFirstEventIsStoredAtOnce(t *testing.T) {
	w := idleLog(t, time.Hour)
	w.log.Emit(LevelInfo, "writer.idle.first", map[string]any{})
	w.waitForFile(t, "writer.idle.first", "a writer that slept")
}

// A record of the source that wakes a writer that slept is stored at once.
// contract: log.native.wake-stores-a-record-at-once
func TestFirstRecordOfTheSourceIsStoredAtOnce(t *testing.T) {
	w := idleLog(t, time.Hour)
	w.source.hold("native.idle.first")
	w.wake <- struct{}{}
	w.waitForFile(t, "native.idle.first", "a Wake of a writer that slept")
}

// The events after the first gather into the batch of the interval: the writer does not write each event. The flush is the
// one write after the first, and the writer writes before it answers the flush.
// contract: log.writer.stores-the-first-event-at-once
func TestEventsAfterTheFirstWaitForTheBatch(t *testing.T) {
	w := idleLog(t, time.Hour)
	w.log.Emit(LevelInfo, "writer.idle.first", map[string]any{})
	w.waitForFile(t, "writer.idle.first", "a writer that slept")
	if w.wrote() != 0 {
		t.Fatal("the first event was written twice")
	}
	w.log.Emit(LevelInfo, "writer.idle.second", map[string]any{})
	w.log.Emit(LevelInfo, "writer.idle.third", map[string]any{})
	if err := w.log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	if writes := w.wrote(); writes != 1 {
		t.Fatalf("the writer made %d writes for the two events of an interval and the flush, want the one of the flush", writes)
	}
	if !fileHas(t, w.log.Path(), "writer.idle.second") || !fileHas(t, w.log.Path(), "writer.idle.third") {
		t.Fatal("the flush did not write the batch")
	}
}

// A refused event makes no write of its own, which would wake the indexer as well: a writer that sleeps keeps the count, and
// the next event carries it to the file. The first count wakes the writer for the start and the end of one interval, after
// which it sleeps with the count held, and a further count wakes nothing. The check sets the bound on the rate of the reports
// to zero, so the carrier is not held back by it.
// contract: log.writer.a-count-waits-for-a-write
func TestACountWaitsForTheNextWrite(t *testing.T) {
	w := idleLog(t, 5*time.Millisecond)
	w.log.SetGatedReportInterval(0)
	from := w.source.pulls.Load()
	if w.log.Gate(ClassIo, LevelTrace) {
		t.Fatal("the default policy stores io at trace")
	}
	if !w.slept(t) {
		t.Fatal("the writer slept without the count of the gate")
	}
	for range 49 {
		if w.log.Gate(ClassIo, LevelTrace) {
			t.Fatal("the default policy stores io at trace")
		}
	}
	if fileHas(t, w.log.Path(), "log.gated") || w.wrote() != 0 {
		t.Fatal("a count alone was written to the file")
	}
	if pulls := w.source.pulls.Load() - from; pulls != 2 {
		t.Fatalf("the counts woke the writer for %d pulls; the first count takes the start and the end of one interval", pulls)
	}
	w.log.Emit(LevelInfo, "writer.idle.carrier", map[string]any{})
	w.waitForFile(t, "log.gated", "the count that waited for an event")
}

// A count of the gate leaves a sleeping writer as log.gated after its wait: no other event may be there to carry it. The
// check sets the wait and the bound on the rate of the reports to zero, so the report follows the end of one interval.
// contract: log.writer.a-count-waits-for-a-write
func TestGateCountWakesTheWriter(t *testing.T) {
	w := idleLog(t, 5*time.Millisecond)
	w.log.SetGatedWait(0)
	w.log.SetGatedReportInterval(0)
	if w.log.Gate(ClassIo, LevelTrace) {
		t.Fatal("the default policy stores io at trace")
	}
	w.waitForFile(t, "log.gated", "the count of the gate")
}

// A loss that no message carries leaves a sleeping writer as log.dropped at once.
// contract: log.writer.sleeps-with-nothing-to-write
func TestLossWakesTheWriter(t *testing.T) {
	w := idleLog(t, time.Hour)
	w.log.countLoss(ChannelOther, LossQueueFull, 7)
	w.waitForFile(t, "log.dropped", "a loss of a writer that slept")
}

// Close stores what waits for an interval and what the source holds, and needs no Wake for it.
// contract: log.native.close-stores-the-ring
func TestCloseStoresWhatWaits(t *testing.T) {
	w := idleLog(t, time.Hour)
	w.log.Emit(LevelInfo, "writer.idle.first", map[string]any{})
	w.waitForFile(t, "writer.idle.first", "a writer that slept")
	w.log.Emit(LevelInfo, "writer.idle.second", map[string]any{})
	w.source.hold("native.idle.held")
	w.log.Close()
	for _, event := range []string{"writer.idle.second", "native.idle.held"} {
		if !fileHas(t, w.log.Path(), event) {
			t.Fatalf("Close did not store %s", event)
		}
	}
}

// Close and Flush of a writer that sleeps take the source, which may not have said that it holds something.
// contract: log.native.close-stores-the-ring
func TestAWriterThatSleepsTakesTheSourceAtTheEnd(t *testing.T) {
	w := idleLog(t, time.Hour)
	log, source := w.log, w.source
	source.hold("native.idle.flushed")
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	if !fileHas(t, log.Path(), "native.idle.flushed") {
		t.Fatal("Flush of a writer that sleeps did not take the source")
	}
	source.hold("native.idle.closed")
	log.Close()
	if !fileHas(t, log.Path(), "native.idle.closed") {
		t.Fatal("Close of a writer that sleeps did not take the source")
	}
}

// A process with a Pull and no Wake could not hear its source.
// contract: log.native.pull-needs-a-wake
func TestPullNeedsWake(t *testing.T) {
	useEventLogFilesystemPlatform(t)
	_, err := StartEventLog(EventLogOptions{
		Directory: t.TempDir(), Role: "host", Boot: "idle", Layer: "host", Clock: func() uint64 { return 1 },
		Spawn:       func(_ string, run func()) { go run() },
		QueueEvents: 64, QueueBytes: 1 << 20, BatchInterval: time.Millisecond,
		Pull: func(func(RelayedEvent), func(uint64, uint64, string, Channel)) {},
	})
	if err == nil || !strings.Contains(err.Error(), "Wake") {
		t.Fatalf("a Pull without a Wake was accepted: %v", err)
	}
}

// The source puts the second request in the queue while the writer pulls for the first, so a writer that drains for a flush
// finds it there. An interval of an hour keeps the end of an interval out of the answer.
// contract: log.writer.flush-behind-a-flush-or-a-stop-is-answered
func TestAFlushThatAFlushFindsBehindItIsAnswered(t *testing.T) {
	useEventLogFilesystemPlatform(t)
	second := make(chan struct{})
	var armed atomic.Bool
	var log *EventLog
	var err error
	log, err = StartEventLog(EventLogOptions{
		Directory: t.TempDir(), Role: "host", Boot: "flush", Layer: "host", Clock: func() uint64 { return 1 },
		Spawn:       func(_ string, run func()) { go run() },
		QueueEvents: 64, QueueBytes: 1 << 20, BatchInterval: time.Hour,
		Pull: func(func(RelayedEvent), func(uint64, uint64, string, Channel)) {
			if armed.CompareAndSwap(true, false) {
				log.messages <- eventMessage{flush: second}
			}
		},
		Wake: make(chan struct{}, 1),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.Close)
	armed.Store(true)
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	select {
	case <-second:
	case <-time.After(5 * time.Second):
		t.Fatal("the flush behind the flush was not answered")
	}
}

// A flush request and an event are in the queue behind the stop: the source puts them there while the writer pulls for it.
// contract: log.writer.flush-behind-a-flush-or-a-stop-is-answered
func TestAFlushThatAStopFindsBehindItIsAnswered(t *testing.T) {
	useEventLogFilesystemPlatform(t)
	second := make(chan struct{})
	var armed atomic.Bool
	var log *EventLog
	var err error
	log, err = StartEventLog(EventLogOptions{
		Directory: t.TempDir(), Role: "host", Boot: "flush", Layer: "host", Clock: func() uint64 { return 1 },
		Spawn:       func(_ string, run func()) { go run() },
		QueueEvents: 64, QueueBytes: 1 << 20, BatchInterval: time.Hour,
		Pull: func(func(RelayedEvent), func(uint64, uint64, string, Channel)) {
			if armed.CompareAndSwap(true, false) {
				log.messages <- eventMessage{flush: second}
				log.Emit(LevelInfo, "writer.flush.behind", map[string]any{})
			}
		},
		Wake: make(chan struct{}, 1),
	})
	if err != nil {
		t.Fatal(err)
	}
	armed.Store(true)
	log.Close()
	select {
	case <-second:
	case <-time.After(5 * time.Second):
		t.Fatal("the flush behind the stop was not answered")
	}
	if !fileHas(t, log.Path(), "writer.flush.behind") {
		t.Fatal("the event behind the flush was not stored")
	}
}

// A writer that does not answer leaves its caller the deadline, and the error names it.
// contract: log.writer.flush-at-exit
func TestAFlushThatGetsNoAnswerReportsItsDeadline(t *testing.T) {
	useEventLogFilesystemPlatform(t)
	log, err := StartEventLog(EventLogOptions{
		Directory: t.TempDir(), Role: "host", Boot: "idle", Layer: "host", Clock: func() uint64 { return 1 },
		Spawn:       func(string, func()) {},
		QueueEvents: 64, QueueBytes: 1 << 20, BatchInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(time.Millisecond); err == nil || !strings.Contains(err.Error(), "within") {
		t.Fatalf("Flush of a writer that does not answer returned %v", err)
	}
}

// A writer that ended cannot answer, and its caller learns that at once and not as a deadline that passed.
// contract: log.writer.flush-behind-a-flush-or-a-stop-is-answered
func TestAFlushOfAWriterThatEndedSaysSo(t *testing.T) {
	log := idleLog(t, time.Hour).log
	log.Close()
	answered := make(chan error, 1)
	go func() { answered <- log.Flush(time.Hour) }()
	select {
	case err := <-answered:
		if err == nil || !strings.Contains(err.Error(), "ended") || strings.Contains(err.Error(), "within") {
			t.Fatalf("Flush of a writer that ended returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Flush of a writer that ended waited for its deadline")
	}
}
