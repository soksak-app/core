package host

import (
	"testing"
)

func TestStepRecordsReachTheClassFrame(t *testing.T) {
	isolateTraceRecords(t)
	writeStepRecord(StepRecord{Window: "main", Kind: "selector", Callback: "mouseMoved:", Entry: 10, Return: 40, Forwarded: 3, Wait: 7})
	writeStepRecord(StepRecord{Kind: "block", Callback: "app.Open", Entry: 50, Return: 60})
	records := bufferedTraces(t, "host.frame.step")
	if len(records) != 2 {
		t.Fatalf("%d step records, want 2", len(records))
	}
	first := records[0]
	if first["window"] != "main" || first["kind"] != "selector" || first["callback"] != "mouseMoved:" || first["entry_ns"] != "10" ||
		first["return_ns"] != "40" || first["forwarded"] != float64(3) || first["wait_ns"] != "7" {
		t.Fatalf("the record of a step: %v", first)
	}
	if records[1]["window"] != nil || records[1]["wait_ns"] != "0" {
		t.Fatalf("the record of a step without a window with focus: %v", records[1])
	}
}

// fakeStepFramework starts and stops recordings and hands out what they report.
type fakeStepFramework struct {
	starts, stops int
	report        func(StepRecord)
	lost          func(uint64)
}

func (f *fakeStepFramework) RecordSteps(report func(StepRecord), lost func(uint64)) func() {
	f.starts++
	f.report, f.lost = report, lost
	return func() { f.stops++ }
}

func TestStepRecordingFollowsTheStoredLevelOfTheClassFrame(t *testing.T) {
	fake := &fakeStepFramework{}
	stored := false
	losses := uint64(0)
	recording := newStepRecording(fake.RecordSteps, func() bool { return stored }, func(n uint64) { losses += n })
	recording.sync()
	if fake.starts != 0 {
		t.Fatalf("a policy that stores no debug frame records started %d recordings", fake.starts)
	}
	stored = true
	recording.sync()
	recording.sync()
	if fake.starts != 1 || fake.stops != 0 {
		t.Fatalf("a policy that stores them: %d starts and %d stops, want 1 and 0", fake.starts, fake.stops)
	}
	fake.lost(4)
	if losses != 4 {
		t.Fatalf("the losses reached %d, want 4", losses)
	}
	stored = false
	recording.sync()
	recording.sync()
	if fake.stops != 1 {
		t.Fatalf("a policy that stops storing them: %d stops, want 1", fake.stops)
	}
	stored = true
	recording.sync()
	recording.stop()
	recording.stop()
	if fake.starts != 2 || fake.stops != 2 {
		t.Fatalf("after the end: %d starts and %d stops, want 2 and 2", fake.starts, fake.stops)
	}
}

func TestStepRecordingWithoutFrameworkStepsRecordsNothing(t *testing.T) {
	recording := newStepRecording(func(func(StepRecord), func(uint64)) func() { return nil }, func() bool { return true }, func(uint64) {})
	recording.sync()
	recording.stop()
}
