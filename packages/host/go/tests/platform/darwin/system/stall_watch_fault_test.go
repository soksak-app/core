//go:build darwin && diagnostics

// The tests of the stall watch whose sample lasts as long as the test holds it, through the fault point SOKSAK_FAULT_STALL_SAMPLE of
// the diagnostics build (stall_fault.go of the host library): the sample of a stall of the real platform lasts one second, which
// does not order the end of a stall, the sample of a later stall and the stop of the watch.
package system_test

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	testplatform "github.com/soksak-app/core/packages/host/go/tests/platform"
)

// faultStallSample is the fault point of the sample of a stall, which names the FIFO that holds the sample.
const faultStallSample = "SOKSAK_FAULT_STALL_SAMPLE"

func init() {
	stallScenarios["sample-keeps-the-watch"] = sampleKeepsTheWatchScenario
	stallScenarios["ends-in-a-wait"] = endsInAWaitScenario
	stallScenarios["stop-waits"] = stopWaitsScenario
}

// holdSamples makes the FIFO that holds the samples of the stalls of the scenario and sets the fault point to it.
func holdSamples(config string) (string, error) {
	fifo := filepath.Join(config, "sample.fifo")
	if err := testplatform.MakeFifo(fifo); err != nil {
		return "", err
	}
	if err := os.Setenv(faultStallSample, fifo); err != nil {
		return "", err
	}
	return fifo, nil
}

// releaseSamples ends the wait of the sample that the FIFO holds: the writer closes the FIFO.
func releaseSamples(fifo string) error {
	file, err := os.OpenFile(fifo, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	return file.Close()
}

// sampleKeepsTheWatchScenario holds the sample of the first stall while the main thread has two stalls with an end each: the watch
// keeps sending heartbeats, so the second stall is found and reports the sample that runs.
func sampleKeepsTheWatchScenario(config string) error {
	fifo, err := holdSamples(config)
	if err != nil {
		return err
	}
	run, err := startStallRun(config, nil, nil)
	if err != nil {
		return err
	}
	if err := pumpRunLoop(600 * time.Millisecond); err != nil {
		return err
	}
	// The thread is held until the watch stores the stall, and answers again, which ends it.
	if err := run.holdUntil("host.stall", 1); err != nil {
		return err
	}
	if err := run.pumpUntil("host.stall.resumed", 1); err != nil {
		return err
	}
	// The sample of the first stall still runs when the second stall is found.
	if err := run.holdUntil("host.stall.sampled", 1); err != nil {
		return err
	}
	if err := run.pumpUntil("host.stall.resumed", 2); err != nil {
		return err
	}
	if err := releaseSamples(fifo); err != nil {
		return err
	}
	// The run loop turns while the sample ends, so the wait for its record starts no later stall.
	if err := run.pumpUntil("host.stall.sampled", 2); err != nil {
		return err
	}
	run.finish()
	return nil
}

// contract: host.stall.sample-keeps-the-watch-running
func TestASampleOfTheThreadsDoesNotStopTheWatch(t *testing.T) {
	records := stallRecordsOf(t, "sample-keeps-the-watch")
	if got, want := namesOf(records), "host.stall,host.stall.resumed,host.stall,host.stall.sampled,host.stall.resumed,host.stall.sampled"; got != want {
		t.Fatalf("events %q, want %q", got, want)
	}
	for _, record := range records {
		if record.name == "host.stall" {
			record.requireLate(t)
		}
	}
	if records[3].fields["error"] != "a sample of the threads is still running" {
		t.Fatalf("the second sample reports %v", records[3].fields)
	}
	records[5].requireSample(t)
	requireLevels(t, records)
}

// endsInAWaitScenario holds the sample of a stall while the main thread ends the stall and its run loop waits.
func endsInAWaitScenario(config string) error {
	fifo, err := holdSamples(config)
	if err != nil {
		return err
	}
	run, err := startStallRun(config, nil, nil)
	if err != nil {
		return err
	}
	if err := pumpRunLoop(600 * time.Millisecond); err != nil {
		return err
	}
	if err := run.holdUntil("host.stall", 1); err != nil {
		return err
	}
	// The main thread returns and its run loop waits: the watch stores the end and parks in that wait, while the sample goes on
	// apart from it.
	if err := run.pumpUntil("host.stall.resumed", 1); err != nil {
		return err
	}
	if got := run.joined(); got != "host.stall,host.stall.resumed" {
		return fmt.Errorf("the watch stored %q before the sample ended", got)
	}
	if err := releaseSamples(fifo); err != nil {
		return err
	}
	// The run loop turns while the sample ends, so the wait for its record starts no later stall.
	if err := run.pumpUntil("host.stall.sampled", 1); err != nil {
		return err
	}
	run.finish()
	return nil
}

// contract: host.stall.ends-when-the-run-loop-waits
func TestAStallThatEndsInAWaitIsResumedAndItsSampleEnds(t *testing.T) {
	records := stallRecordsOf(t, "ends-in-a-wait")
	if got := namesOf(records); got != "host.stall,host.stall.resumed,host.stall.sampled" {
		t.Fatalf("events %q, want the stall, its end and its sample", got)
	}
	records[0].requireLate(t)
	if stalled := records[1].milliseconds(t, "stalled_ms"); stalled < 1000 || stalled >= 3000 {
		t.Fatalf("stalled_ms %d, want 1000 up to 3000", stalled)
	}
	records[2].requireSample(t)
	requireLevels(t, records)
}

// stopWaitsScenario stops the watch while the sample of a stall runs: the stop begins to wait for the sample, returns only after
// the sample ended and stored its record, and the watch has run one sample.
func stopWaitsScenario(config string) error {
	fifo, err := holdSamples(config)
	if err != nil {
		return err
	}
	waiting := make(chan struct{})
	run, err := startStallRun(config, nil, func() { close(waiting) })
	if err != nil {
		return err
	}
	if err := pumpRunLoop(600 * time.Millisecond); err != nil {
		return err
	}
	// The main thread is held until the watch stores the stall, whose sample lasts until the FIFO is released.
	if err := run.holdUntil("host.stall", 1); err != nil {
		return err
	}
	returned := make(chan struct{})
	go func() {
		run.stop()
		close(returned)
	}()
	// The sample ends only after the stop began to wait for it, so a stop that returns before that event returned while the
	// sample ran, and one that neither waits nor returns ends at the limit of the scenario.
	stillRan := errors.New("the stop of the watch returned while the sample of the threads still ran")
	select {
	case <-waiting:
	case <-returned:
		return stillRan
	case <-time.After(stallScenarioDeadline):
		return errors.New("the stop of the watch did not begin to wait for the sample")
	}
	select {
	case <-returned:
		return stillRan
	default:
	}
	if err := releaseSamples(fifo); err != nil {
		return err
	}
	select {
	case <-returned:
	case <-time.After(stallScenarioDeadline):
		return errors.New("the stop of the watch did not return after the sample ended")
	}
	if got := run.joined(); got != "host.stall,host.stall.sampled" {
		return fmt.Errorf("the stop returned with the events %q, want the stall and its sample", got)
	}
	run.finish()
	return nil
}

// contract: host.stall.stop-waits-for-the-sample
func TestStoppingTheWatchWaitsForTheRunningSample(t *testing.T) {
	records := stallRecordsOf(t, "stop-waits")
	if got := namesOf(records); got != "host.stall,host.stall.sampled" {
		t.Fatalf("events %q, want the stall and its sample", got)
	}
	records[0].requireLate(t)
	records[1].requireSample(t)
	requireLevels(t, records)
}
