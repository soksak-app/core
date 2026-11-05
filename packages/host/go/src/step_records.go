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

// stepRecording runs the recording of the framework while the policy stores the step records or a listener hears them, because
// a recording costs a drain of its records and a time reading in each step.
type stepRecording struct {
	mu      sync.Mutex
	start   func(report func(StepRecord), lost func(uint64)) (stop func())
	enabled func() bool
	lost    func(uint64)
	running bool
	end     func()
	// listener hears each step until its listen ends; r.mu guards it.
	listener func(StepRecord)
}

func newStepRecording(start func(func(StepRecord), func(uint64)) func(), enabled func() bool, lost func(uint64)) *stepRecording {
	return &stepRecording{start: start, enabled: enabled, lost: lost}
}

// sync starts or stops the recording after the policy changed.
func (r *stepRecording) sync() {
	r.mu.Lock()
	defer r.mu.Unlock()
	on := r.enabled() || r.listener != nil
	switch {
	case on && !r.running:
		r.begin()
	case !on && r.running:
		r.halt()
	}
}

// listen gives each step to report until the returned function returns, which has reported the last step before it. A running
// recording ends for each change of the listener, because only the end of a recording drains what the main thread recorded.
func (r *stepRecording) listen(report func(StepRecord)) (end func()) {
	r.relisten(report)
	return func() { r.relisten(nil) }
}

func (r *stepRecording) relisten(report func(StepRecord)) {
	r.mu.Lock()
	if r.running {
		r.halt()
	}
	r.listener = report
	r.mu.Unlock()
	r.sync()
}

// begin starts the recording. r.mu is held.
func (r *stepRecording) begin() {
	listener := r.listener
	r.end = r.start(func(record StepRecord) {
		writeStepRecord(record)
		if listener != nil {
			listener(record)
		}
	}, r.lost)
	r.running = true
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
