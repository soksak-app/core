//go:build darwin && diagnostics

// The pull of the native ring against the real ring of the process (docs/spec/logging.md#writers): the scheduling of the writer
// that pulls the ring and the loss of a ring that overflows. The ring and its loss counts belong to the process, so each test runs
// in a child process of this test binary that no other test used. The records come from the real producer function of the native
// library (sampler.EmitNativeEvent). The decoder, the refused records and the stored form of the decoded events
// are data tests of packages/host/go/src/event_native_test.go.
package system_test

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	sampler "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// nativeRingChild marks the child process of a test of the native ring.
const nativeRingChild = "SOKSAK_NATIVE_RING_CHILD"

// nativeRingLimit is the time limit of one child process of a test of the native ring.
const nativeRingLimit = 60 * time.Second

// noInterval does not end during a test, so what a test finds in the file was not written at the end of an interval.
const noInterval = time.Hour

// The class and the levels of the records of these tests, as numbers of the native library: the class call, and the levels info and
// debug, which the channels other and debug store.
const (
	nativeClassCall  = 2
	nativeLevelInfo  = 2
	nativeLevelDebug = 3
)

// inNativeRingChild runs the calling test in a child process of this test binary and reports whether this process is that child. The
// parent returns false after the child ended, and the test then returns.
func inNativeRingChild(t *testing.T) bool {
	t.Helper()
	if os.Getenv(nativeRingChild) != "" {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), nativeRingLimit)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run", "^"+t.Name()+"$", "-test.count=1")
	command.Env = append(os.Environ(), nativeRingChild+"=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("the child of %s ended with %v: %s", t.Name(), err, output)
	}
	return false
}

// nativeRing returns the platform after the policy of the native library stores every level of every class.
// The default policy stores only errors.
func nativeRing(t *testing.T) platform.Platform {
	t.Helper()
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	if err := system.SetNativeEventPolicy([5]int8{4, 4, 4, 4, 4}); err != nil {
		t.Fatal(err)
	}
	// The process may hold records, counts of the gate or a pending wake from before the test: a refused producer call or a drain that
	// leaves a record sets the pending wake, and the pipe of the ring opens readable when a wake is pending (event_ring.m,
	// sp_event_wake_fd), which gives the writer a wake that no record of the test caused. The test starts from an empty ring and a
	// pending wake that is cleared, by taking what the ring holds and its loss.
	buffer := make([]byte, 256<<10)
	for {
		n, err := system.PullNativeEvents(buffer)
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			break
		}
	}
	for channel := uint8(0); channel < 2; channel++ {
		if _, _, err := system.TakeNativeEventLoss(channel); err != nil {
			t.Fatal(err)
		}
	}
	return system
}

// stores reports whether the file of the log holds the event.
func stores(t *testing.T, log *host.EventLog, name string) bool {
	t.Helper()
	for _, event := range support.ReadEvents(t, log.Path()) {
		if event["event"] == name {
			return true
		}
	}
	return false
}

// wakingLog is a writer of the real ring with the events of its sleeps and its writes and the count of its pulls.
type wakingLog struct {
	*host.EventLog
	// sleeps receives each sleep of the writer; writes receives each batch it wrote.
	sleeps chan bool
	writes chan struct{}
	// pulls counts the pulls of the writer. A pull of the writer reads the platform until a read gives no bytes, so each pull ends
	// with one empty read, and the count is the count of those reads; the read is the real one and the count changes no answer.
	pulls atomic.Int64
}

// waitFor waits for the writes of the writer until one of them stored the event. It takes the write that stored it, so a count
// of the writes that follow starts after it.
func (w *wakingLog) waitFor(t *testing.T, name string) {
	t.Helper()
	for {
		<-w.writes
		if stores(t, w.EventLog, name) {
			return
		}
	}
}

// slept waits for the next sleep of the writer.
func (w *wakingLog) slept(t *testing.T) {
	t.Helper()
	<-w.sleeps
}

// startWaking starts a writer with options and returns it once it took what its start left and slept. Only an event, a wake,
// a loss, a request or the report of a held count wakes a writer that sleeps, so what follows is what the test does.
func startWaking(t *testing.T, options host.EventLogOptions) *wakingLog {
	t.Helper()
	w := &wakingLog{sleeps: make(chan bool, 64), writes: make(chan struct{}, 64)}
	pull := options.Pull
	options.Pull = func(buffer []byte) (int, error) {
		n, err := pull(buffer)
		if err == nil && n == 0 {
			w.pulls.Add(1)
		}
		return n, err
	}
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.Close)
	w.EventLog = log
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

// ringOptions are the options of a writer that pulls the real ring and is woken by it.
func ringOptions(t *testing.T, system platform.Platform, interval time.Duration) host.EventLogOptions {
	t.Helper()
	options := support.EventLogOptions(t.TempDir())
	options.BatchInterval = interval
	if err := options.UseNativeRing(system); err != nil {
		t.Fatal(err)
	}
	return options
}

// emitRecord stores a record of the class call in the real ring.
func emitRecord(t *testing.T, level uint8, name, fields string) {
	t.Helper()
	if err := sampler.EmitNativeEvent(nativeClassCall, level, name, fields); err != nil {
		t.Fatal(err)
	}
}

// contract: log.native.wake-stores-a-record-at-once
func TestAWakeOfTheRingStoresItsRecordAtOnce(t *testing.T) {
	if !inNativeRingChild(t) {
		return
	}
	system := nativeRing(t)
	log := startWaking(t, ringOptions(t, system, noInterval))
	emitRecord(t, nativeLevelInfo, "native.test.late", `{}`)
	log.waitFor(t, "native.test.late")
}

// The writer is not woken by the ring: its Wake is a channel that no record signals, as when a wake was lost.
// contract: log.native.close-stores-the-ring
func TestCloseStoresTheRecordsOfTheRingWithoutAWake(t *testing.T) {
	if !inNativeRingChild(t) {
		return
	}
	system := nativeRing(t)
	options := support.EventLogOptions(t.TempDir())
	options.BatchInterval = noInterval
	options.Pull = system.PullNativeEvents
	options.Wake = make(chan struct{})
	log := startWaking(t, options)
	emitRecord(t, nativeLevelInfo, "native.test.late", `{}`)
	log.Close()
	if !stores(t, log.EventLog, "native.test.late") {
		t.Fatal("Close did not store the record of the ring")
	}
}

// The start takes the ring once and sleeps, and a wake takes it at once and at the end of the interval it starts, after which
// the writer sleeps again.
// contract: log.writer.sleeps-with-nothing-to-write
func TestAWriterWithNothingToWriteDoesNotPull(t *testing.T) {
	if !inNativeRingChild(t) {
		return
	}
	system := nativeRing(t)
	log := startWaking(t, ringOptions(t, system, 5*time.Millisecond))
	if pulled := log.pulls.Load(); pulled != 1 {
		t.Fatalf("the writer pulled %d times before it slept, want the one of its start", pulled)
	}
	emitRecord(t, nativeLevelInfo, "native.test.late", `{}`)
	log.slept(t)
	if pulled := log.pulls.Load() - 1; pulled != 2 {
		t.Fatalf("the writer pulled %d times after one wake, want at once and at the end of the interval", pulled)
	}
}

// The close is the one write after the first event, and the writer writes before the close returns.
// contract: log.writer.stores-the-first-event-at-once
func TestAWriterThatSleptStoresTheFirstEventAtOnceAndGathersTheNext(t *testing.T) {
	if !inNativeRingChild(t) {
		return
	}
	system := nativeRing(t)
	log := startWaking(t, ringOptions(t, system, noInterval))
	if !log.Emit(host.LevelInfo, "host.test.first", map[string]any{}) {
		t.Fatal("the first event was refused")
	}
	log.waitFor(t, "host.test.first")
	if len(log.writes) != 0 {
		t.Fatal("the first event was written twice")
	}
	for _, name := range []string{"host.test.second", "host.test.third"} {
		if !log.Emit(host.LevelInfo, name, map[string]any{}) {
			t.Fatalf("%s was refused", name)
		}
	}
	log.Close()
	if writes := len(log.writes); writes != 1 {
		t.Fatalf("the writer made %d writes for the two events of an interval and the close, want the one of the close", writes)
	}
	if !stores(t, log.EventLog, "host.test.second") || !stores(t, log.EventLog, "host.test.third") {
		t.Fatal("Close did not store the batch")
	}
}

// A ring that no writer drains fills; the events that it refuses are counted by the channel of their level and reach the log as
// the loss of the ring.
// contract: log.native.counts-refused-records-and-ring-loss
func TestTheLossOfAFullRingIsCountedAsDroppedByChannel(t *testing.T) {
	if !inNativeRingChild(t) {
		return
	}
	system := nativeRing(t)
	// A record of 100 KiB: the ring of 4 MiB holds a few dozen, and two of them fit the buffer of one pull.
	fields := `{"pad":"` + strings.Repeat("x", 100<<10) + `"}`
	const name = "native.test.fill"
	const limit = 256
	stored, refusedOther, refusedDebug := 0, 0, 0
	for sampler.EmitNativeEvent(nativeClassCall, nativeLevelInfo, name, fields) == nil {
		if stored++; stored > limit {
			t.Fatalf("the ring held %d records without a writer", stored)
		}
	}
	refusedOther++
	// The records that follow have the size of the refused one, so a full ring refuses each, in the channel of its level.
	for range 2 {
		if err := sampler.EmitNativeEvent(nativeClassCall, nativeLevelInfo, name, fields); err == nil {
			t.Fatal("a record was stored in the full ring")
		}
		refusedOther++
	}
	for range 2 {
		if err := sampler.EmitNativeEvent(nativeClassCall, nativeLevelDebug, name, fields); err == nil {
			t.Fatal("a record of the channel debug was stored in the full ring")
		}
		refusedDebug++
	}
	log, err := host.StartEventLog(ringOptions(t, system, 20*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.Close)
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	pulled, reasons, channels := 0, map[string]float64{}, map[string]float64{}
	for _, event := range support.ReadEvents(t, log.Path()) {
		switch event["event"] {
		case name:
			pulled++
		case "log.dropped":
			fields := event["fields"].(map[string]any)
			reasons[fields["reason"].(string)] += fields["count"].(float64)
			channels[fields["reason"].(string)+"/"+fields["channel"].(string)] += fields["count"].(float64)
		}
	}
	if pulled != stored || reasons["the native ring was full"] != float64(refusedOther+refusedDebug) || len(reasons) != 1 {
		t.Fatalf("pulled %d of %d stored records, dropped %v, want %d refused", pulled, stored, reasons, refusedOther+refusedDebug)
	}
	// The loss of the ring names the channel of the refused events.
	if channels["the native ring was full/other"] != float64(refusedOther) || channels["the native ring was full/debug"] != float64(refusedDebug) {
		t.Fatalf("dropped by channel %v", channels)
	}
}
