package host_test

import (
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// neverWaits is the run loop of a main thread that always handles an event.
func neverWaits() {}

// contract: host.stall.recorded-without-a-check
func TestABlockedMainThreadIsRecordedWithItsStacksAndItsEnd(t *testing.T) {
	// A fake main thread: the watch sends its heartbeat here, and the test holds the thread for 1.6 s.
	work := make(chan func(), 64)
	hold := make(chan struct{})
	go func() {
		for f := range work {
			f()
		}
	}()
	var mu sync.Mutex
	var events []string
	var fields []map[string]any
	var levels []host.Level
	var names []string
	var sampled []string
	start := time.Now()
	clock := func() time.Duration { return time.Since(start) }
	var answered atomic.Int64
	stop := host.StartStallWatch(host.StallWatchOptions{
		Heartbeat: func() (time.Duration, time.Duration) {
			work <- func() { answered.Store(int64(clock())) }
			return clock(), time.Duration(answered.Load())
		},
		AwaitAwake: neverWaits,
		Clock:      clock,
		Sample:     func(path string) error { mu.Lock(); sampled = append(sampled, path); mu.Unlock(); return nil },
		Folder:     t.TempDir(),
		EmitHost: func(level host.Level, event string, f map[string]any) {
			mu.Lock()
			levels = append(levels, level)
			names = append(names, event)
			events = append(events, event)
			fields = append(fields, f)
			mu.Unlock()
		},
	})
	defer stop()
	time.Sleep(600 * time.Millisecond)
	work <- func() { <-hold }
	time.Sleep(1600 * time.Millisecond)
	close(hold)
	time.Sleep(800 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(events, ",") != "host.stall,host.stall.sampled,host.stall.resumed" {
		t.Fatalf("events %v, want one stall, its sample and its end", events)
	}
	if late, _ := fields[0]["late_ms"].(int64); late < 1000 {
		t.Fatalf("late_ms %v, want at least 1000", fields[0]["late_ms"])
	}
	if path, _ := fields[1]["path"].(string); !strings.Contains(path, "stall-host-") || len(sampled) != 1 || sampled[0] != path {
		t.Fatalf("sampled %v into %v", sampled, fields[1])
	}
	if stalled, _ := fields[2]["stalled_ms"].(int64); stalled < 1000 {
		t.Fatalf("stalled_ms %v, want at least 1000", fields[2]["stalled_ms"])
	}
	// The stall and its dump are warnings, which the policy stores through the gate exception of PassesEveryGate; the end of the
	// stall is info.
	for i, name := range names {
		want := host.LevelWarn
		if name == "host.stall.resumed" {
			want = host.LevelInfo
		}
		if levels[i] != want {
			t.Fatalf("%s at %v, want %v", name, levels[i], want)
		}
	}
}

// controlledTime is a clock that the test controls. Each wait advances it by one beat, and by extra on the first beat, which
// models a process that the system does not schedule for that long; the wait sleeps 1 ms so that the watch does not spin.
type controlledTime struct {
	mu    sync.Mutex
	now   time.Duration
	extra time.Duration
	first bool
}

func (c *controlledTime) clock() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *controlledTime) wait(beat time.Duration) {
	c.mu.Lock()
	c.now += beat
	if c.first {
		c.now += c.extra
		c.first = false
	}
	c.mu.Unlock()
	time.Sleep(time.Millisecond)
}

// firstStall runs the watch with a main thread that never takes a task, and returns the fields of the first host.stall record.
func firstStall(t *testing.T, extra time.Duration) map[string]any {
	t.Helper()
	ct := &controlledTime{extra: extra, first: true}
	records := make(chan struct {
		name   string
		fields map[string]any
	}, 64)
	stop := host.StartStallWatch(host.StallWatchOptions{
		// The main thread never answers, so the time of the answer stays the time of the first heartbeat, the start of the clock.
		Heartbeat:  func() (time.Duration, time.Duration) { return ct.clock(), 0 },
		AwaitAwake: neverWaits,
		Sample:     func(string) error { return nil },
		Folder:     t.TempDir(),
		EmitHost: func(_ host.Level, event string, fields map[string]any) {
			records <- struct {
				name   string
				fields map[string]any
			}{event, fields}
		},
		Clock: ct.clock,
		Wait:  ct.wait,
	})
	defer stop()
	for {
		select {
		case record := <-records:
			if record.name == "host.stall" {
				return record.fields
			}
		case <-time.After(10 * time.Second):
			t.Fatal("no host.stall record")
		}
	}
}

// int64Field returns a field of a record, which the watch stores as an int64.
func int64Field(t *testing.T, fields map[string]any, key string) int64 {
	t.Helper()
	value, ok := fields[key].(int64)
	if !ok {
		t.Fatalf("host.stall field %s is %v (%T), want an int64", key, fields[key], fields[key])
	}
	return value
}

// contract: host.stall.watch-late-separates-scheduling
func TestAStallOfAnUnscheduledProcessCarriesItsLatenessInTheWatch(t *testing.T) {
	// The first beat is 1600 ms late for the watch and for the main thread alike, so the stall is seen at 1850 ms.
	fields := firstStall(t, 1600*time.Millisecond)
	if got := int64Field(t, fields, "late_ms"); got != 1850 {
		t.Fatalf("late_ms %d, want 1850", got)
	}
	if got := int64Field(t, fields, "watch_late_ms"); got != 1600 {
		t.Fatalf("watch_late_ms %d, want 1600", got)
	}
}

// contract: host.stall.watch-late-separates-blocked-main
func TestAStallOfABlockedMainThreadHasNoLatenessInTheWatch(t *testing.T) {
	// The watch wakes on every beat; the main thread never runs the heartbeat, so the stall is seen at 1000 ms.
	fields := firstStall(t, 0)
	if got := int64Field(t, fields, "late_ms"); got != 1000 {
		t.Fatalf("late_ms %d, want 1000", got)
	}
	if got := int64Field(t, fields, "watch_late_ms"); got != 0 {
		t.Fatalf("watch_late_ms %d, want 0", got)
	}
}

// contract: host.stall.sample-keeps-the-watch-running
func TestASampleOfTheThreadsDoesNotStopTheWatch(t *testing.T) {
	// A fake main thread and a sample that lasts until the test ends it, as a sample of a loaded system lasts for seconds.
	work := make(chan func(), 64)
	go func() {
		for f := range work {
			f()
		}
	}()
	release := make(chan struct{})
	var mu sync.Mutex
	var events []string
	var fields []map[string]any
	seen := func(want string, count int) bool {
		mu.Lock()
		defer mu.Unlock()
		found := 0
		for _, name := range events {
			if name == want {
				found++
			}
		}
		return found >= count
	}
	await := func(want string, count int) {
		t.Helper()
		deadline := time.Now().Add(4 * time.Second)
		for !seen(want, count) {
			if time.Now().After(deadline) {
				mu.Lock()
				defer mu.Unlock()
				t.Fatalf("no %d of %s while the sample runs: events %v", count, want, events)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	start := time.Now()
	clock := func() time.Duration { return time.Since(start) }
	var answered atomic.Int64
	stop := host.StartStallWatch(host.StallWatchOptions{
		Heartbeat: func() (time.Duration, time.Duration) {
			work <- func() { answered.Store(int64(clock())) }
			return clock(), time.Duration(answered.Load())
		},
		AwaitAwake: neverWaits,
		Clock:      clock,
		Sample:     func(string) error { <-release; return nil },
		Folder:     t.TempDir(),
		EmitHost: func(_ host.Level, event string, f map[string]any) {
			mu.Lock()
			events = append(events, event)
			fields = append(fields, f)
			mu.Unlock()
		},
	})
	defer stop()
	blockMain := func() {
		hold := make(chan struct{})
		work <- func() { <-hold }
		time.Sleep(1400 * time.Millisecond)
		close(hold)
	}
	time.Sleep(300 * time.Millisecond)
	blockMain()
	await("host.stall.resumed", 1)
	blockMain()
	await("host.stall.resumed", 2)
	close(release)
	await("host.stall.sampled", 2)
	mu.Lock()
	defer mu.Unlock()
	if got := strings.Join(events, ","); got != "host.stall,host.stall.resumed,host.stall,host.stall.sampled,host.stall.resumed,host.stall.sampled" {
		t.Fatalf("events %s, want two stalls that end while the first sample runs, and the two samples", got)
	}
	for index, name := range events {
		if name == "host.stall" {
			if late := int64Field(t, fields[index], "late_ms"); late >= 2000 {
				t.Fatalf("late_ms %d of a main thread blocked for 1.4 s", late)
			}
		}
	}
	if fields[3]["error"] != "a sample of the threads is still running" {
		t.Fatalf("the second sample reports %v", fields[3])
	}
	if _, failed := fields[5]["error"]; failed {
		t.Fatalf("the first sample reports %v", fields[5])
	}
}

// fakeRunLoop is a main run loop that waits or handles an event, with the state that the observers of the platform write: the
// start of a wait and a wake are answers, and while it waits a heartbeat sends nothing and returns the start of the wait as both
// times. While held it takes no heartbeat.
type fakeRunLoop struct {
	mu         sync.Mutex
	awake      *sync.Cond
	clock      func() time.Duration
	waits      bool
	held       bool
	answered   time.Duration
	heartbeats int
	blocked    int
}

func newFakeRunLoop(clock func() time.Duration) *fakeRunLoop {
	loop := &fakeRunLoop{clock: clock, waits: true}
	loop.awake = sync.NewCond(&loop.mu)
	return loop
}

func (l *fakeRunLoop) heartbeat() (time.Duration, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.waits {
		return l.answered, l.answered
	}
	l.heartbeats++
	now := l.clock()
	if !l.held {
		l.answered = now
	}
	return now, l.answered
}

func (l *fakeRunLoop) awaitAwake() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.blocked++
	for l.waits {
		l.awake.Wait()
	}
	l.blocked--
}

func (l *fakeRunLoop) wake(held bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.waits, l.held, l.answered = false, held, l.clock()
	l.awake.Broadcast()
}

func (l *fakeRunLoop) wait() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.waits, l.held, l.answered = true, false, l.clock()
}

func (l *fakeRunLoop) sent() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.heartbeats
}

// awaitBlocked returns when the watch blocks on the wait of the run loop.
func (l *fakeRunLoop) awaitBlocked(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for {
		l.mu.Lock()
		blocked := l.blocked > 0
		l.mu.Unlock()
		if blocked {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the watch does not block while the run loop waits")
		}
		time.Sleep(time.Millisecond)
	}
}

// awaitHeartbeats returns when the watch has sent the count of heartbeats.
func (l *fakeRunLoop) awaitHeartbeats(t *testing.T, count int) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for l.sent() < count {
		if time.Now().After(deadline) {
			t.Fatalf("%d heartbeats, want %d", l.sent(), count)
		}
		time.Sleep(time.Millisecond)
	}
}

// stallRecords collects the names and the fields of the records of a watch.
type stallRecords struct {
	mu     sync.Mutex
	names  []string
	fields []map[string]any
}

func (r *stallRecords) emit(_ host.Level, event string, fields map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.names = append(r.names, event)
	r.fields = append(r.fields, fields)
}

func (r *stallRecords) joined() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.names, ",")
}

func (r *stallRecords) await(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for r.joined() != want {
		if time.Now().After(deadline) {
			t.Fatalf("events %q, want %q", r.joined(), want)
		}
		time.Sleep(time.Millisecond)
	}
}

// contract: host.stall.waiting-run-loop-takes-no-heartbeat
func TestARunLoopThatWaitsTakesNoHeartbeat(t *testing.T) {
	ct := &controlledTime{}
	loop := newFakeRunLoop(ct.clock)
	records := &stallRecords{}
	stop := host.StartStallWatch(host.StallWatchOptions{
		Heartbeat: loop.heartbeat, AwaitAwake: loop.awaitAwake, Sample: func(string) error { return nil },
		Folder: t.TempDir(), EmitHost: records.emit, Clock: ct.clock, Wait: ct.wait,
	})
	defer func() {
		stop()
		loop.wake(false)
	}()

	// The run loop waits from the start of the watch.
	loop.awaitBlocked(t)
	time.Sleep(100 * time.Millisecond)
	if got := loop.sent(); got != 0 {
		t.Fatalf("%d heartbeats to a run loop that waits", got)
	}

	// It wakes and the beats start.
	loop.wake(false)
	loop.awaitHeartbeats(t, 4)

	// It waits again: the watch blocks, and a time much longer than a beat sends nothing and stores nothing.
	loop.wait()
	loop.awaitBlocked(t)
	sent := loop.sent()
	ct.mu.Lock()
	ct.now += 10 * time.Second
	ct.mu.Unlock()
	time.Sleep(100 * time.Millisecond)
	if got := loop.sent(); got != sent {
		t.Fatalf("%d heartbeats to a run loop that waits", got-sent)
	}

	// The wake ends the block, and the 10 s of the wait are no lateness.
	loop.wake(false)
	loop.awaitHeartbeats(t, sent+4)
	if got := records.joined(); got != "" {
		t.Fatalf("a wait of the run loop stored %s", got)
	}

	// A run loop that wakes and does not turn is a stall, measured from its wake.
	loop.wait()
	loop.awaitBlocked(t)
	loop.wake(true)
	records.await(t, "host.stall,host.stall.sampled")
	records.mu.Lock()
	defer records.mu.Unlock()
	if got := int64Field(t, records.fields[0], "late_ms"); got != 1000 {
		t.Fatalf("late_ms %d, want 1000 from the wake", got)
	}
	if got := int64Field(t, records.fields[0], "watch_late_ms"); got != 0 {
		t.Fatalf("watch_late_ms %d, want 0", got)
	}
}

// contract: host.stall.ends-when-the-run-loop-waits
func TestAStallThatEndsInAWaitIsResumedAndItsSampleEnds(t *testing.T) {
	ct := &controlledTime{}
	loop := newFakeRunLoop(ct.clock)
	records := &stallRecords{}
	release := make(chan struct{})
	stop := host.StartStallWatch(host.StallWatchOptions{
		Heartbeat: loop.heartbeat, AwaitAwake: loop.awaitAwake, Sample: func(string) error { <-release; return nil },
		Folder: t.TempDir(), EmitHost: records.emit, Clock: ct.clock, Wait: ct.wait,
	})
	defer func() {
		stop()
		loop.wake(false)
	}()
	loop.awaitBlocked(t)
	loop.wake(true)
	records.await(t, "host.stall")

	// The main thread returns and its run loop waits before the next beat: the watch stores the end and then blocks, while the
	// sample goes on apart from it.
	loop.wait()
	records.await(t, "host.stall,host.stall.resumed")
	loop.awaitBlocked(t)
	close(release)
	records.await(t, "host.stall,host.stall.resumed,host.stall.sampled")
	records.mu.Lock()
	defer records.mu.Unlock()
	if got := int64Field(t, records.fields[1], "stalled_ms"); got < 1000 {
		t.Fatalf("stalled_ms %d, want at least 1000", got)
	}
}
