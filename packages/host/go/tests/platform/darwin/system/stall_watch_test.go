//go:build darwin

// The tests of the stall watch of the host (docs/spec/logging.md, stalls) against the real platform. The main run loop answers the
// heartbeat on the main thread only while the thread runs it, so each test runs its scenario in a child process of this test binary:
// TestMain runs the scenario on the main goroutine, which stays on the main thread, and the scenario runs the main run loop or holds
// the thread. The watch stores its records in the event log of the configuration folder of the test, which the test reads.
package system_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	sampler "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

const (
	// stallScenarioChild is the environment variable that names the scenario that a child process runs.
	stallScenarioChild = "SOKSAK_STALL_SCENARIO"
	// stallScenarioConfig is the environment variable that names the configuration folder of the scenario.
	stallScenarioConfig = "SOKSAK_STALL_CONFIG"
	// stallScenarioLimit is the time limit of one child process of a stall scenario.
	stallScenarioLimit = 60 * time.Second
	// stallScenarioDeadline is the time after which a scenario that still waits for a record ends with an error.
	stallScenarioDeadline = 30 * time.Second
)

// stallScenarios are the scenarios that a child process runs, by name. Each file of this package adds its own.
var stallScenarios = map[string]func(config string) error{}

func init() {
	stallScenarios["blocked"] = blockedScenario
	stallScenarios["waits"] = waitsScenario
}

// runStallScenario runs the scenario of a child process on the main goroutine.
func runStallScenario(name string) error {
	scenario, found := stallScenarios[name]
	if !found {
		return fmt.Errorf("unknown stall scenario %q", name)
	}
	config := os.Getenv(stallScenarioConfig)
	if config == "" {
		return fmt.Errorf("the stall scenario %q has no configuration folder in %s", name, stallScenarioConfig)
	}
	return scenario(config)
}

// stallRun is the watch of a scenario with the real platform and the real event log, and the count of the records that the watch
// stored, which the scenario waits for.
type stallRun struct {
	log     *host.EventLog
	stop    func()
	mu      sync.Mutex
	changed *sync.Cond
	names   []string
	expired bool
	timer   *time.Timer
}

// startStallRun starts the event log of the configuration folder with every level stored and the watch of the main thread. A nil
// heartbeat is the heartbeat of the platform; stopWaits is the StopWaits of the watch.
func startStallRun(config string, heartbeat func() (now, answered time.Duration), stopWaits func()) (*stallRun, error) {
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	log, err := host.StartHostEventLog(config)
	if err != nil {
		return nil, err
	}
	policy, err := host.ParseLogPolicy("every level", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`))
	if err != nil {
		return nil, err
	}
	log.SetPolicy(policy, "file")
	if err := log.Flush(); err != nil {
		return nil, err
	}
	host.UseHostEventLog(log)
	run := &stallRun{log: log}
	run.changed = sync.NewCond(&run.mu)
	run.timer = time.AfterFunc(stallScenarioDeadline, func() {
		run.mu.Lock()
		run.expired = true
		run.changed.Broadcast()
		run.mu.Unlock()
	})
	if heartbeat == nil {
		heartbeat = host.StallHeartbeat(system)
	}
	run.stop = host.StartStallWatch(host.StallWatchOptions{
		Heartbeat:  heartbeat,
		AwaitAwake: system.StallAwaitAwake,
		Schedule:   system.StallSchedule,
		Sample:     system.SampleThreads,
		Folder:     filepath.Join(config, "logs"),
		EmitHost:   run.emit,
		StopWaits:  stopWaits,
	})
	return run, nil
}

// emit stores the record of the watch in the event log and counts it.
func (r *stallRun) emit(level host.Level, name string, fields map[string]any) {
	host.EmitHost(level, name, fields)
	r.mu.Lock()
	r.names = append(r.names, name)
	r.changed.Broadcast()
	r.mu.Unlock()
}

// counted is the number of records of name that the watch stored.
func (r *stallRun) counted(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.countedLocked(name)
}

func (r *stallRun) countedLocked(name string) int {
	count := 0
	for _, stored := range r.names {
		if stored == name {
			count++
		}
	}
	return count
}

// joined is the names of the records that the watch stored, in order.
func (r *stallRun) joined() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.names, ",")
}

// holdUntil holds the main thread, so that it runs no run loop, until the watch stored count records of name.
func (r *stallRun) holdUntil(name string, count int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for r.countedLocked(name) < count {
		if r.expired {
			return fmt.Errorf("the watch stored %q, want %d of %s", strings.Join(r.names, ","), count, name)
		}
		r.changed.Wait()
	}
	return nil
}

// pumpUntil runs the main run loop until the watch stored count records of name.
func (r *stallRun) pumpUntil(name string, count int) error {
	for r.counted(name) < count {
		r.mu.Lock()
		expired, names := r.expired, strings.Join(r.names, ",")
		r.mu.Unlock()
		if expired {
			return fmt.Errorf("the watch stored %q, want %d of %s", names, count, name)
		}
		if err := pumpRunLoop(100 * time.Millisecond); err != nil {
			return err
		}
	}
	return nil
}

// finish stops the watch, which waits for its running sample, and ends the event log, which stores what the watch stored.
func (r *stallRun) finish() {
	r.timer.Stop()
	r.stop()
	host.UseHostEventLog(nil)
	r.log.Close()
}

// stallRecord is a record of the watch in the event log.
type stallRecord struct {
	name   string
	level  string
	fields map[string]any
}

// stallRecordsOf runs the scenario in a child process of this test binary and returns the records of the watch in the event log of
// its configuration folder, with the child environment that env adds.
func stallRecordsOf(t *testing.T, scenario string, env ...string) []stallRecord {
	t.Helper()
	config := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), stallScenarioLimit)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0])
	command.Env = append(append(os.Environ(), stallScenarioChild+"="+scenario, stallScenarioConfig+"="+config), env...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("child %s ended with %v, output %q", scenario, err, output)
	}
	var records []stallRecord
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		name, _ := event["event"].(string)
		if !strings.HasPrefix(name, "host.stall") {
			continue
		}
		level, _ := event["level"].(string)
		fields, _ := event["fields"].(map[string]any)
		records = append(records, stallRecord{name, level, fields})
	}
	return records
}

// namesOf joins the names of the records.
func namesOf(records []stallRecord) string {
	names := make([]string, len(records))
	for i, record := range records {
		names[i] = record.name
	}
	return strings.Join(names, ",")
}

// milliseconds returns a field of a record, which the event log stores as a number.
func (r stallRecord) milliseconds(t *testing.T, key string) int64 {
	t.Helper()
	value, ok := r.fields[key].(float64)
	if !ok {
		t.Fatalf("%s field %s is %v (%T), want a number", r.name, key, r.fields[key], r.fields[key])
	}
	return int64(value)
}

// requireLate requires the late_ms of a stall found by a heartbeat that is stallLate or more late, at most one beat and the
// scheduling of a loaded system after the threshold.
func (r stallRecord) requireLate(t *testing.T) {
	t.Helper()
	if late := r.milliseconds(t, "late_ms"); late < 1000 || late >= 2000 {
		t.Fatalf("late_ms %d of a main thread that did not turn, want 1000 up to 2000", late)
	}
}

// requireSample requires the record of a sample that ended without an error and wrote its file.
func (r stallRecord) requireSample(t *testing.T) {
	t.Helper()
	path, _ := r.fields["path"].(string)
	if !strings.Contains(path, "stall-host-") {
		t.Fatalf("the sample path is %q, want a stall-host file", path)
	}
	if failure, failed := r.fields["error"]; failed {
		t.Fatalf("the sample reports %v", failure)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the sample file: %v", err)
	}
}

// requireLevels requires the level of each record: the stall and its dump are warnings, which the policy stores through the gate
// exception of PassesEveryGate, and the end of the stall is info.
func requireLevels(t *testing.T, records []stallRecord) {
	t.Helper()
	for _, record := range records {
		want := "warn"
		if record.name == "host.stall.resumed" {
			want = "info"
		}
		if record.level != want {
			t.Fatalf("%s at %v, want %v", record.name, record.level, want)
		}
	}
}

// blockedScenario runs the main run loop and holds it from a time on: the watch records the stall and its sample, and when the
// main thread runs the run loop again, the end of the stall.
func blockedScenario(config string) error {
	run, err := startStallRun(config, nil, nil)
	if err != nil {
		return err
	}
	// The main thread answers each heartbeat while it runs its run loop, and a turn of 600 ms is no stall.
	if err := pumpRunLoop(600 * time.Millisecond); err != nil {
		return err
	}
	if got := run.joined(); got != "" {
		return fmt.Errorf("the watch stored %q for a main thread that ran its run loop", got)
	}
	// The thread is held from here: the heartbeat of the watch is late by a second and the sample of that stall ends.
	if err := run.holdUntil("host.stall.sampled", 1); err != nil {
		return err
	}
	// The main thread answers again, which is the end of the stall.
	if err := run.pumpUntil("host.stall.resumed", 1); err != nil {
		return err
	}
	run.finish()
	return nil
}

// contract: host.stall.recorded-without-a-check
func TestABlockedMainThreadIsRecordedWithItsStacksAndItsEnd(t *testing.T) {
	records := stallRecordsOf(t, "blocked")
	if got := namesOf(records); got != "host.stall,host.stall.sampled,host.stall.resumed" {
		t.Fatalf("events %q, want the stall, its sample and its end", got)
	}
	records[0].requireLate(t)
	records[1].requireSample(t)
	if stalled, late := records[2].milliseconds(t, "stalled_ms"), records[0].milliseconds(t, "late_ms"); stalled < late {
		t.Fatalf("stalled_ms %d is shorter than late_ms %d of the same stall", stalled, late)
	}
	requireLevels(t, records)
}

// waitsScenario starts the watch, runs a main run loop that waits for 2 s, which is longer than a stall, and then holds it from its
// wake. The heartbeat of the platform counts the heartbeats that it sent through the counts of the native library.
func waitsScenario(config string) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	platformHeartbeat := host.StallHeartbeat(system)
	var mu sync.Mutex
	reads := 0
	sentAtRead := uint64(0)
	heartbeat := func() (time.Duration, time.Duration) {
		before := sampler.ReadStallCounts().Sent
		now, answered := platformHeartbeat()
		if after := sampler.ReadStallCounts().Sent; after == before {
			// A heartbeat that sent nothing read a wait of the run loop.
			mu.Lock()
			if reads == 0 {
				sentAtRead = after
			}
			reads++
			mu.Unlock()
		}
		return now, answered
	}
	run, err := startStallRun(config, heartbeat, nil)
	if err != nil {
		return err
	}
	// The run loop waits for 2 s: the watch reads the wait with its heartbeat, sends nothing to the waiting run loop, and stores
	// nothing for the 2 s.
	if err := pumpRunLoop(2 * time.Second); err != nil {
		return err
	}
	sent := sampler.ReadStallCounts().Sent
	mu.Lock()
	read, atRead := reads, sentAtRead
	mu.Unlock()
	if read == 0 {
		return errors.New("no heartbeat of the watch read the wait of the run loop")
	}
	if sent != atRead {
		return fmt.Errorf("%d heartbeats were sent to a run loop that waits", sent-atRead)
	}
	// The wake ends the block, and the 2 s of the wait are no lateness.
	if err := pumpRunLoop(600 * time.Millisecond); err != nil {
		return err
	}
	if got := run.joined(); got != "" {
		return fmt.Errorf("the watch stored %q for a run loop that waited", got)
	}
	// A run loop that wakes and does not turn is a stall, measured from its wake.
	if err := run.holdUntil("host.stall.sampled", 1); err != nil {
		return err
	}
	run.finish()
	return nil
}

// contract: host.stall.waiting-run-loop-takes-no-heartbeat
func TestARunLoopThatWaitsTakesNoHeartbeat(t *testing.T) {
	records := stallRecordsOf(t, "waits")
	if got := namesOf(records); got != "host.stall,host.stall.sampled" {
		t.Fatalf("events %q, want the stall of the wake and its sample only", got)
	}
	records[0].requireLate(t)
	if got := records[0].milliseconds(t, "watch_late_ms"); got >= 250 {
		t.Fatalf("watch_late_ms %d, want a watch that wakes on time", got)
	}
	records[1].requireSample(t)
}
