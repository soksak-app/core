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

// steppedTime is a clock that the test moves. The wait of each beat tells the test that the watch parked there, and the watch
// takes the beat when the test lets it, late by an extra time that models a process that the system does not schedule for that
// long. The watch handles a beat in full before it waits for the next one, so the place where it parks is the event after which
// that beat stores nothing more. The end of the test ends every park.
type steppedTime struct {
	mu      sync.Mutex
	now     time.Duration
	parked  chan string
	proceed chan time.Duration
	done    chan struct{}
}

func newSteppedTime(t *testing.T) *steppedTime {
	s := &steppedTime{parked: make(chan string), proceed: make(chan time.Duration), done: make(chan struct{})}
	t.Cleanup(func() { close(s.done) })
	return s
}

func (s *steppedTime) clock() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.now
}

func (s *steppedTime) advance(length time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now += length
}

// park tells the test that the watch parked at place, and reports false when the test ended.
func (s *steppedTime) park(place string) bool {
	select {
	case s.parked <- place:
		return true
	case <-s.done:
		return false
	}
}

func (s *steppedTime) wait(beat time.Duration) {
	if !s.park("beat") {
		return
	}
	select {
	case extra := <-s.proceed:
		s.advance(beat + extra)
	case <-s.done:
	}
}

// requirePark requires that the watch parks next at place: "beat" for the wait of a beat and "awake" for the wait of the run loop.
func (s *steppedTime) requirePark(t *testing.T, place string) {
	t.Helper()
	if got := <-s.parked; got != place {
		t.Fatalf("the watch parked at %s, want %s", got, place)
	}
}

// beat lets the watch that parked at a beat take it, late by extra, and requires that it parks next at place.
func (s *steppedTime) beat(t *testing.T, extra time.Duration, place string) {
	t.Helper()
	s.proceed <- extra
	s.requirePark(t, place)
}

// beats lets the watch take count beats on time, each followed by the wait of the next beat.
func (s *steppedTime) beats(t *testing.T, count int) {
	t.Helper()
	for range count {
		s.beat(t, 0, "beat")
	}
}

// contract: host.stall.recorded-without-a-check
func TestABlockedMainThreadIsRecordedWithItsStacksAndItsEnd(t *testing.T) {
	// A fake main thread that answers each heartbeat until the test holds it.
	clock := newSteppedTime(t)
	loop := newFakeRunLoop(clock)
	loop.wake(false)
	records := newStallRecords()
	var mu sync.Mutex
	var sampled []string
	stop := host.StartStallWatch(host.StallWatchOptions{
		Heartbeat:  loop.heartbeat,
		AwaitAwake: loop.awaitAwake,
		Sample:     func(path string) error { mu.Lock(); sampled = append(sampled, path); mu.Unlock(); return nil },
		Folder:     t.TempDir(),
		EmitHost:   records.emit,
		Clock:      clock.clock,
		Wait:       clock.wait,
	})
	defer stop()
	// The first heartbeat and two beats are answered. The main thread is held from 500 ms, and the fourth beat after that is
	// 1000 ms late; the sample of that stall ends before the next beat.
	clock.requirePark(t, "beat")
	clock.beats(t, 2)
	loop.wake(true)
	clock.beats(t, 4)
	records.requireBeats(t, "host.stall")
	records.await(t, "host.stall,host.stall.sampled")
	// The main thread answers again, and the next beat at 1750 ms is the end of the stall.
	loop.wake(false)
	clock.beats(t, 1)
	records.require(t, "host.stall,host.stall.sampled,host.stall.resumed")
	records.mu.Lock()
	defer records.mu.Unlock()
	if got := int64Field(t, records.fields[0], "late_ms"); got != 1000 {
		t.Fatalf("late_ms %d, want 1000", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if path, _ := records.fields[1]["path"].(string); !strings.Contains(path, "stall-host-") || len(sampled) != 1 || sampled[0] != path {
		t.Fatalf("sampled %v into %v", sampled, records.fields[1])
	}
	if got := int64Field(t, records.fields[2], "stalled_ms"); got != 1250 {
		t.Fatalf("stalled_ms %d, want 1250", got)
	}
	// The stall and its dump are warnings, which the policy stores through the gate exception of PassesEveryGate; the end of the
	// stall is info.
	for i, name := range records.names {
		want := host.LevelWarn
		if name == "host.stall.resumed" {
			want = host.LevelInfo
		}
		if records.levels[i] != want {
			t.Fatalf("%s at %v, want %v", name, records.levels[i], want)
		}
	}
}

// firstStall runs the watch with a main thread that never takes a task, and returns the fields of the first host.stall record.
// The first beat is late by extra.
func firstStall(t *testing.T, extra time.Duration) map[string]any {
	t.Helper()
	clock := newSteppedTime(t)
	records := newStallRecords()
	stop := host.StartStallWatch(host.StallWatchOptions{
		// The main thread never answers, so the time of the answer stays the time of the first heartbeat, the start of the clock.
		Heartbeat:  func() (time.Duration, time.Duration) { return clock.clock(), 0 },
		AwaitAwake: neverWaits,
		Sample:     func(string) error { return nil },
		Folder:     t.TempDir(),
		EmitHost:   records.emit,
		Clock:      clock.clock,
		Wait:       clock.wait,
	})
	defer stop()
	clock.requirePark(t, "beat")
	for beat := 1; beat <= 4; beat++ {
		clock.beat(t, extra, "beat")
		extra = 0
		records.mu.Lock()
		var name string
		var fields map[string]any
		if len(records.names) > 0 {
			name, fields = records.names[0], records.fields[0]
		}
		records.mu.Unlock()
		switch name {
		case "":
		case "host.stall":
			return fields
		default:
			t.Fatalf("the first record is %s, want host.stall", name)
		}
	}
	t.Fatal("no host.stall record after 4 beats of a main thread that never answers")
	return nil
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
	clock := newSteppedTime(t)
	loop := newFakeRunLoop(clock)
	loop.wake(false)
	records := newStallRecords()
	release := make(chan struct{})
	var releasing sync.Once
	free := func() { releasing.Do(func() { close(release) }) }
	stop := host.StartStallWatch(host.StallWatchOptions{
		Heartbeat:  loop.heartbeat,
		AwaitAwake: loop.awaitAwake,
		Sample:     func(string) error { <-release; return nil },
		Folder:     t.TempDir(),
		EmitHost:   records.emit,
		Clock:      clock.clock,
		Wait:       clock.wait,
	})
	defer stop()
	defer free()
	// stallAndEnd holds the main thread for four beats, which is a stall, and answers again on the next beat, which ends it.
	stallAndEnd := func(want string) {
		t.Helper()
		loop.wake(true)
		clock.beats(t, 4)
		loop.wake(false)
		clock.beats(t, 1)
		records.require(t, want)
	}
	clock.requirePark(t, "beat")
	clock.beats(t, 1)
	stallAndEnd("host.stall,host.stall.resumed")
	stallAndEnd("host.stall,host.stall.resumed,host.stall,host.stall.sampled,host.stall.resumed")
	free()
	records.await(t, "host.stall,host.stall.resumed,host.stall,host.stall.sampled,host.stall.resumed,host.stall.sampled")
	records.mu.Lock()
	defer records.mu.Unlock()
	for index, name := range records.names {
		if name == "host.stall" {
			if late := int64Field(t, records.fields[index], "late_ms"); late != 1000 {
				t.Fatalf("late_ms %d of a main thread held for four beats, want 1000", late)
			}
		}
	}
	if records.fields[3]["error"] != "a sample of the threads is still running" {
		t.Fatalf("the second sample reports %v", records.fields[3])
	}
	if _, failed := records.fields[5]["error"]; failed {
		t.Fatalf("the first sample reports %v", records.fields[5])
	}
}

// fakeRunLoop is a main run loop that waits or handles an event, with the state that the observers of the platform write: the
// start of a wait and a wake are answers, and while it waits a heartbeat sends nothing and returns the start of the wait as both
// times. While held it takes no heartbeat. The watch parks in its wait as "awake" of the stepped clock.
type fakeRunLoop struct {
	mu         sync.Mutex
	awake      *sync.Cond
	time       *steppedTime
	waits      bool
	held       bool
	answered   time.Duration
	heartbeats int
}

func newFakeRunLoop(clock *steppedTime) *fakeRunLoop {
	loop := &fakeRunLoop{time: clock, waits: true}
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
	now := l.time.clock()
	if !l.held {
		l.answered = now
	}
	return now, l.answered
}

func (l *fakeRunLoop) awaitAwake() {
	l.mu.Lock()
	waits := l.waits
	l.mu.Unlock()
	if !waits || !l.time.park("awake") {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for l.waits {
		l.awake.Wait()
	}
}

func (l *fakeRunLoop) wake(held bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.waits, l.held, l.answered = false, held, l.time.clock()
	l.awake.Broadcast()
}

func (l *fakeRunLoop) wait() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.waits, l.held, l.answered = true, false, l.time.clock()
}

func (l *fakeRunLoop) sent() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.heartbeats
}

// stallRecords collects the names, the levels and the fields of the records of a watch, and tells each record.
type stallRecords struct {
	mu     sync.Mutex
	names  []string
	levels []host.Level
	fields []map[string]any
	added  chan struct{}
}

func newStallRecords() *stallRecords {
	return &stallRecords{added: make(chan struct{}, 1)}
}

func (r *stallRecords) emit(level host.Level, event string, fields map[string]any) {
	r.mu.Lock()
	r.names = append(r.names, event)
	r.levels = append(r.levels, level)
	r.fields = append(r.fields, fields)
	r.mu.Unlock()
	select {
	case r.added <- struct{}{}:
	default:
	}
}

func (r *stallRecords) joined() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.names, ",")
}

// require checks the records that the beats stored, after the watch parked.
func (r *stallRecords) require(t *testing.T, want string) {
	t.Helper()
	if got := r.joined(); got != want {
		t.Fatalf("events %q, want %q", got, want)
	}
}

// requireBeats checks the records that the beats stored, after the watch parked, while the sample of the stall runs apart from
// the beats and ends without a wait of its own: its host.stall.sampled comes before or after that park, so it is not one of them.
func (r *stallRecords) requireBeats(t *testing.T, want string) {
	t.Helper()
	r.mu.Lock()
	names := make([]string, 0, len(r.names))
	for _, name := range r.names {
		if name != "host.stall.sampled" {
			names = append(names, name)
		}
	}
	r.mu.Unlock()
	if got := strings.Join(names, ","); got != want {
		t.Fatalf("events that the beats stored %q, want %q", got, want)
	}
}

// await waits for the records of a sample, which ends apart from the beats.
func (r *stallRecords) await(t *testing.T, want string) {
	t.Helper()
	for r.joined() != want {
		<-r.added
	}
}

// contract: host.stall.waiting-run-loop-takes-no-heartbeat
func TestARunLoopThatWaitsTakesNoHeartbeat(t *testing.T) {
	clock := newSteppedTime(t)
	loop := newFakeRunLoop(clock)
	records := newStallRecords()
	stop := host.StartStallWatch(host.StallWatchOptions{
		Heartbeat: loop.heartbeat, AwaitAwake: loop.awaitAwake, Sample: func(string) error { return nil },
		Folder: t.TempDir(), EmitHost: records.emit, Clock: clock.clock, Wait: clock.wait,
	})
	defer func() {
		stop()
		loop.wake(false)
	}()

	// The run loop waits from the start of the watch, and the watch parks in that wait before it sends anything.
	clock.requirePark(t, "awake")
	if got := loop.sent(); got != 0 {
		t.Fatalf("%d heartbeats to a run loop that waits", got)
	}

	// It wakes and the beats start.
	loop.wake(false)
	clock.requirePark(t, "beat")
	clock.beats(t, 3)
	if got := loop.sent(); got != 4 {
		t.Fatalf("%d heartbeats after the first and three beats, want 4", got)
	}

	// It waits again: the beat after that parks the watch in the wait, so a time much longer than a beat sends nothing and stores
	// nothing.
	loop.wait()
	clock.beat(t, 0, "awake")
	sent := loop.sent()
	clock.advance(10 * time.Second)
	if got := loop.sent(); got != sent {
		t.Fatalf("%d heartbeats to a run loop that waits", got-sent)
	}

	// The wake ends the block, and the 10 s of the wait are no lateness.
	loop.wake(false)
	clock.requirePark(t, "beat")
	clock.beats(t, 4)
	if got := loop.sent(); got != sent+4 {
		t.Fatalf("%d heartbeats after the wake, want 4", got-sent)
	}
	records.require(t, "")

	// A run loop that wakes and does not turn is a stall, measured from its wake.
	loop.wait()
	clock.beat(t, 0, "awake")
	loop.wake(true)
	clock.requirePark(t, "beat")
	clock.beats(t, 4)
	records.requireBeats(t, "host.stall")
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
	clock := newSteppedTime(t)
	loop := newFakeRunLoop(clock)
	records := newStallRecords()
	release := make(chan struct{})
	var releasing sync.Once
	free := func() { releasing.Do(func() { close(release) }) }
	stop := host.StartStallWatch(host.StallWatchOptions{
		Heartbeat: loop.heartbeat, AwaitAwake: loop.awaitAwake, Sample: func(string) error { <-release; return nil },
		Folder: t.TempDir(), EmitHost: records.emit, Clock: clock.clock, Wait: clock.wait,
	})
	defer func() {
		free()
		stop()
		loop.wake(false)
	}()
	clock.requirePark(t, "awake")
	loop.wake(true)
	clock.requirePark(t, "beat")
	clock.beats(t, 4)
	records.require(t, "host.stall")

	// The main thread returns and its run loop waits before the next beat: the watch stores the end and parks in that wait, while
	// the sample goes on apart from it.
	loop.wait()
	clock.beat(t, 0, "awake")
	records.require(t, "host.stall,host.stall.resumed")
	free()
	records.await(t, "host.stall,host.stall.resumed,host.stall.sampled")
	records.mu.Lock()
	defer records.mu.Unlock()
	if got := int64Field(t, records.fields[1], "stalled_ms"); got != 1000 {
		t.Fatalf("stalled_ms %d, want 1000", got)
	}
}

// contract: host.stall.stop-waits-for-the-sample
func TestStoppingTheWatchWaitsForTheRunningSample(t *testing.T) {
	// The main thread never answers, so the fourth beat of the stepped clock is a stall that starts a sample. The sample lasts
	// until the test ends it, as the sample of the system lasts for a second, and the stop of the watch comes while it runs.
	clock := newSteppedTime(t)
	records := newStallRecords()
	started := make(chan struct{})
	release := make(chan struct{})
	waiting := make(chan struct{})
	var samples atomic.Int32
	var ended atomic.Bool
	stop := host.StartStallWatch(host.StallWatchOptions{
		Heartbeat:  func() (time.Duration, time.Duration) { return clock.clock(), 0 },
		AwaitAwake: neverWaits,
		Sample: func(string) error {
			if samples.Add(1) == 1 {
				close(started)
			}
			<-release
			ended.Store(true)
			return nil
		},
		Folder:    t.TempDir(),
		EmitHost:  records.emit,
		Clock:     clock.clock,
		Wait:      clock.wait,
		StopWaits: func() { close(waiting) },
	})
	clock.requirePark(t, "beat")
	clock.beats(t, 4)
	<-started
	// The sample ends only after the stop began to wait for it, so a stop that returns before that event returned while the
	// sample ran, and one that neither waits nor returns stops at the limit of the runner.
	returned := make(chan bool, 1)
	go func() {
		stop()
		returned <- ended.Load()
	}()
	select {
	case <-waiting:
	case <-returned:
		t.Fatal("the stop of the watch returned while the sample of the threads still ran")
	}
	select {
	case <-returned:
		t.Fatal("the stop of the watch returned while the sample of the threads still ran")
	default:
	}
	close(release)
	if endedFirst := <-returned; !endedFirst {
		t.Fatal("the stop of the watch returned while the sample of the threads still ran")
	}
	if got := records.joined(); got != "host.stall,host.stall.sampled" {
		t.Fatalf("events %q when the stop returned, want the stall and its sample", got)
	}
	if got := samples.Load(); got != 1 {
		t.Fatalf("%d samples, want the one of the stall", got)
	}
}
