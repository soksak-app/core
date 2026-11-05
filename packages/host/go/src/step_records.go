package host

// The step records of the main thread of a framework that hands the callbacks of the main thread to a worker
// (docs/spec/hosts.md#framework-changes, U7).

import (
	"strconv"
	"sync"
)

// StepRecord is the record of one step. The times are nanoseconds of the host event clock. Window is the window with the
// keyboard focus when the record is written, "" when no window has it. Kind is selector, block or callback.
type StepRecord struct {
	Window, Kind, Callback         string
	Entry, Return, Forwarded, Wait uint64
}

// writeStepRecord writes the event of one step.
func writeStepRecord(record StepRecord) {
	if !GateEvent(ClassFrame, LevelDebug) {
		return
	}
	var window any
	if record.Window != "" {
		window = record.Window
	}
	EmitHost(LevelDebug, "host.frame.step", map[string]any{
		"window": window, "kind": record.Kind, "callback": record.Callback,
		"entry_ns": strconv.FormatUint(record.Entry, 10), "return_ns": strconv.FormatUint(record.Return, 10),
		"forwarded": record.Forwarded, "wait_ns": strconv.FormatUint(record.Wait, 10),
	})
}

// stepRecording runs the recording of the framework while the policy stores the step records, because a recording costs
// a drain of its records and a time reading in each step.
type stepRecording struct {
	mu      sync.Mutex
	start   func(report func(StepRecord), lost func(uint64)) (stop func())
	enabled func() bool
	lost    func(uint64)
	running bool
	end     func()
}

func newStepRecording(start func(func(StepRecord), func(uint64)) func(), enabled func() bool, lost func(uint64)) *stepRecording {
	return &stepRecording{start: start, enabled: enabled, lost: lost}
}

// sync starts or stops the recording after the policy changed.
func (r *stepRecording) sync() {
	r.mu.Lock()
	defer r.mu.Unlock()
	on := r.enabled()
	switch {
	case on && !r.running:
		r.end = r.start(writeStepRecord, r.lost)
		r.running = true
	case !on && r.running:
		r.halt()
	}
}

// stop ends the recording for good.
func (r *stepRecording) stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.enabled = func() bool { return false }
	if r.running {
		r.halt()
	}
}

func (r *stepRecording) halt() {
	r.running = false
	if r.end != nil {
		r.end()
		r.end = nil
	}
}
