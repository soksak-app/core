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

// idleLog starts a writer with a source and the batch interval, and returns them once the writer took what its start left.
// A writer that holds an interval of an hour can store nothing by the end of an interval, so a test of it shows what the
// writer does at once.
func idleLog(t *testing.T, interval time.Duration) (*EventLog, *idleSource, chan struct{}) {
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
	return log, source, wake
}

// settledPulls returns the pull count after the intervals that the start left have ended.
func settledPulls(t *testing.T, source *idleSource) int64 {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		before := source.pulls.Load()
		time.Sleep(30 * time.Millisecond)
		if after := source.pulls.Load(); after == before && after > 0 {
			return after
		}
		if time.Now().After(deadline) {
			t.Fatal("the writer did not settle")
		}
	}
}

func fileHas(t *testing.T, path, text string) bool {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return strings.Contains(string(data), text)
}

func waitForFile(t *testing.T, path, text, what string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !fileHas(t, path, text) {
		if time.Now().After(deadline) {
			t.Fatalf("%s: %s is not stored", what, text)
		}
		time.Sleep(time.Millisecond)
	}
}

// A writer with nothing to write does not wake: the batch interval of the host would be ten wakeups each second of an idle
// application, which G2 of docs/spec/hosts.md does not leave room for.
// contract: log.writer.sleeps-with-nothing-to-write
func TestWriterSleepsWithNothingToWrite(t *testing.T) {
	_, source, _ := idleLog(t, 5*time.Millisecond)
	from := settledPulls(t, source)
	time.Sleep(100 * time.Millisecond)
	if woke := source.pulls.Load() - from; woke != 0 {
		t.Fatalf("the writer pulled %d times in 100 ms with nothing to write", woke)
	}
}

// One Wake takes the source at once and once at the end of the interval it starts, and the writer sleeps again.
// contract: log.writer.sleeps-with-nothing-to-write
func TestWriterSleepsAgainAfterAWake(t *testing.T) {
	_, source, wake := idleLog(t, 5*time.Millisecond)
	from := settledPulls(t, source)
	wake <- struct{}{}
	time.Sleep(100 * time.Millisecond)
	if got := source.pulls.Load() - from; got != 2 {
		t.Fatalf("the writer pulled %d times after one Wake", got)
	}
}

// An event that wakes a writer that slept is stored at once, without an interval and without a flush.
// contract: log.writer.stores-the-first-event-at-once
func TestFirstEventIsStoredAtOnce(t *testing.T) {
	log, source, _ := idleLog(t, time.Hour)
	settledPulls(t, source)
	log.Emit(LevelInfo, "writer.idle.first", map[string]any{})
	waitForFile(t, log.Path(), "writer.idle.first", "a writer that slept")
}

// A record of the source that wakes a writer that slept is stored at once.
// contract: log.native.wake-stores-a-record-at-once
func TestFirstRecordOfTheSourceIsStoredAtOnce(t *testing.T) {
	log, source, wake := idleLog(t, time.Hour)
	settledPulls(t, source)
	source.hold("native.idle.first")
	wake <- struct{}{}
	waitForFile(t, log.Path(), "native.idle.first", "a Wake of a writer that slept")
}

// The events after the first gather into the batch of the interval: the writer does not write each event.
// contract: log.writer.stores-the-first-event-at-once
func TestEventsAfterTheFirstWaitForTheBatch(t *testing.T) {
	log, source, _ := idleLog(t, time.Hour)
	settledPulls(t, source)
	log.Emit(LevelInfo, "writer.idle.first", map[string]any{})
	waitForFile(t, log.Path(), "writer.idle.first", "a writer that slept")
	log.Emit(LevelInfo, "writer.idle.second", map[string]any{})
	time.Sleep(50 * time.Millisecond)
	if fileHas(t, log.Path(), "writer.idle.second") {
		t.Fatal("the second event of an interval was written alone")
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	if !fileHas(t, log.Path(), "writer.idle.second") {
		t.Fatal("the flush did not write the batch")
	}
}

// A refused event makes no write of its own, which would wake the indexer as well: a writer that sleeps keeps the count, and
// the next event carries it to the file.
// contract: log.writer.a-count-waits-for-a-write
func TestACountWaitsForTheNextWrite(t *testing.T) {
	log, source, _ := idleLog(t, 5*time.Millisecond)
	from := settledPulls(t, source)
	for range 50 {
		if log.Gate(ClassIo, LevelTrace) {
			t.Fatal("the default policy stores io at trace")
		}
		time.Sleep(30 * time.Millisecond)
	}
	if fileHas(t, log.Path(), "log.gated") {
		t.Fatal("a count alone was written to the file")
	}
	if pulls := source.pulls.Load() - from; pulls > 2 {
		t.Fatalf("the counts woke the writer for %d pulls; the first count takes the start and the end of one interval", pulls)
	}
	log.Emit(LevelInfo, "writer.idle.carrier", map[string]any{})
	waitForFile(t, log.Path(), "log.gated", "the count that waited for an event")
}

// A count of the gate leaves a sleeping writer as log.gated after its wait: no other event may be there to carry it.
// contract: log.writer.a-count-waits-for-a-write
func TestGateCountWakesTheWriter(t *testing.T) {
	log, source, _ := idleLog(t, 5*time.Millisecond)
	settledPulls(t, source)
	log.SetGatedWait(50 * time.Millisecond)
	if log.Gate(ClassIo, LevelTrace) {
		t.Fatal("the default policy stores io at trace")
	}
	deadline := time.Now().Add(3 * time.Second)
	for !fileHas(t, log.Path(), "log.gated") {
		if time.Now().After(deadline) {
			t.Fatal("the count of the gate was not reported")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A loss that no message carries leaves a sleeping writer as log.dropped at once.
// contract: log.writer.sleeps-with-nothing-to-write
func TestLossWakesTheWriter(t *testing.T) {
	log, source, _ := idleLog(t, time.Hour)
	settledPulls(t, source)
	log.countLoss(ChannelOther, LossQueueFull, 7)
	waitForFile(t, log.Path(), "log.dropped", "a loss of a writer that slept")
}

// Close stores what waits for an interval and what the source holds, and needs no Wake for it.
// contract: log.native.close-stores-the-ring
func TestCloseStoresWhatWaits(t *testing.T) {
	log, source, _ := idleLog(t, time.Hour)
	settledPulls(t, source)
	log.Emit(LevelInfo, "writer.idle.first", map[string]any{})
	waitForFile(t, log.Path(), "writer.idle.first", "a writer that slept")
	log.Emit(LevelInfo, "writer.idle.second", map[string]any{})
	source.hold("native.idle.held")
	log.Close()
	for _, event := range []string{"writer.idle.second", "native.idle.held"} {
		if !fileHas(t, log.Path(), event) {
			t.Fatalf("Close did not store %s", event)
		}
	}
}

// Close and Flush of a writer that sleeps take the source, which may not have said that it holds something.
// contract: log.native.close-stores-the-ring
func TestAWriterThatSleepsTakesTheSourceAtTheEnd(t *testing.T) {
	log, source, _ := idleLog(t, time.Hour)
	settledPulls(t, source)
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
	log, _, _ := idleLog(t, time.Hour)
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
