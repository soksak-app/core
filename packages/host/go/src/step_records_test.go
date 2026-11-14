package host

import (
	"slices"
	"testing"
)

// contract: window.frames.steps-reach-the-class-frame
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

// stepRecorder keeps each start and each stop of a step recording that the judged code makes and the callbacks that it passes. The
// test calls the callbacks as the main thread of a framework does, so the recorder holds no answer of its own.
type stepRecorder struct {
	starts, stops int
	report        func(StepRecord)
	lost          func(uint64)
}

func (f *stepRecorder) RecordSteps(report func(StepRecord), lost func(uint64)) func() {
	f.starts++
	f.report, f.lost = report, lost
	return func() { f.stops++ }
}

// contract: window.frames.step-recording-follows-the-policy
func TestStepRecordingFollowsTheStoredLevelOfTheClassFrame(t *testing.T) {
	recorder := &stepRecorder{}
	stored := false
	losses := uint64(0)
	recording := newStepRecording(recorder.RecordSteps, func() bool { return stored }, func(n uint64) { losses += n })
	recording.sync()
	if recorder.starts != 0 {
		t.Fatalf("a policy that stores no debug frame records started %d recordings", recorder.starts)
	}
	stored = true
	recording.sync()
	recording.sync()
	if recorder.starts != 1 || recorder.stops != 0 {
		t.Fatalf("a policy that stores them: %d starts and %d stops, want 1 and 0", recorder.starts, recorder.stops)
	}
	recorder.lost(4)
	if losses != 4 {
		t.Fatalf("the losses reached %d, want 4", losses)
	}
	stored = false
	recording.sync()
	recording.sync()
	if recorder.stops != 1 {
		t.Fatalf("a policy that stops storing them: %d stops, want 1", recorder.stops)
	}
	stored = true
	recording.sync()
	recording.stop()
	recording.stop()
	if recorder.starts != 2 || recorder.stops != 2 {
		t.Fatalf("after the end: %d starts and %d stops, want 2 and 2", recorder.starts, recorder.stops)
	}
}

// contract: window.frames.step-recording-follows-the-policy
func TestStepRecordingWithoutFrameworkStepsRecordsNothing(t *testing.T) {
	recording := newStepRecording(func(func(StepRecord), func(uint64)) func() { return nil }, func() bool { return true }, func(uint64) {})
	recording.sync()
	recording.stop()
}

// contract: window.frames.step-listener-hears-without-the-policy
func TestAListenerHearsEachStepWithoutThePolicyAndEndsWithADrain(t *testing.T) {
	recorder := &stepRecorder{}
	stored := false
	recording := newStepRecording(recorder.RecordSteps, func() bool { return stored }, func(uint64) {})
	heard := []string{}
	end := recording.listen(func(step StepRecord) { heard = append(heard, step.Callback) })
	if recorder.starts != 1 {
		t.Fatalf("a listener started %d recordings, want 1", recorder.starts)
	}
	recorder.report(StepRecord{Callback: "first"})
	end()
	if recorder.stops != 1 || recorder.starts != 1 {
		t.Fatalf("the end of the listener: %d starts and %d stops, want 1 and 1", recorder.starts, recorder.stops)
	}
	if !slices.Equal(heard, []string{"first"}) {
		t.Fatalf("the listener heard %v", heard)
	}
	// Under a policy that stores the records, the end of a listener drains and the recording goes on without it.
	stored = true
	recording.sync()
	end = recording.listen(func(step StepRecord) { heard = append(heard, step.Callback) })
	if recorder.starts != 3 || recorder.stops != 2 {
		t.Fatalf("a listener under the policy: %d starts and %d stops, want 3 and 2", recorder.starts, recorder.stops)
	}
	end()
	if recorder.starts != 4 || recorder.stops != 3 {
		t.Fatalf("the end under the policy: %d starts and %d stops, want 4 and 3", recorder.starts, recorder.stops)
	}
	recorder.report(StepRecord{Callback: "after"})
	if !slices.Equal(heard, []string{"first"}) {
		t.Fatalf("after its end the listener heard %v", heard)
	}
}
