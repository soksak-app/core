package host

// The frame counters and records of a window whose workbench the host draws (docs/spec/hosts.md#framework-changes, U7). Each
// report runs on the thread that drew the frame, and status reads, notifications and diagnostics read on goroutines of their own.

import (
	"strconv"
	"sync/atomic"
)

// settledState is what the last frame of a window reported.
const (
	settledUnknown uint32 = iota
	settledNo
	settledYes
)

// FrameRecord is the record of one frame. The times are nanoseconds of the host event clock; a Request of 0 tells that the frame
// requested no presentation.
type FrameRecord struct {
	Start, Request, End, DrawableWait    uint64
	Damage, Nodes                        int
	Outcome                              string
	CommandBuffer                        bool
	AsksFrame, Animates, Repaints, Timer bool
}

// WindowFrames counts the frames and the command buffers of one window and writes their records to the event log.
type WindowFrames struct {
	window         string
	frames         atomic.Uint64
	commandBuffers atomic.Uint64
	settled        atomic.Uint32
	nodes          atomic.Int64
	nativeViews    atomic.Int64
	onSettled      atomic.Pointer[func()]
}

// NewWindowFrames returns the counters of the named window.
func NewWindowFrames(window string) *WindowFrames { return &WindowFrames{window: window} }

// Clock returns the time of a record, or 0 while the class frame stores no record.
func (w *WindowFrames) Clock() uint64 {
	if !GateEvent(ClassFrame, LevelDebug) || system == nil {
		return 0
	}
	value, err := system.MonotonicNanos()
	if err != nil {
		LogError("frame record clock", err)
		return 0
	}
	return value
}

// Frame counts one frame and writes its record. A record of a frame that began while the class stored nothing has no start, and
// is not written.
func (w *WindowFrames) Frame(record *FrameRecord) {
	w.frames.Add(1)
	if record.CommandBuffer {
		w.commandBuffers.Add(1)
	}
	w.nodes.Store(int64(record.Nodes))
	state := settledNo
	if !record.AsksFrame && !record.Animates && !record.Repaints && !record.Timer {
		state = settledYes
	}
	if previous := w.settled.Swap(state); previous != state {
		if notify := w.onSettled.Load(); notify != nil {
			(*notify)()
		}
	}
	if record.Start == 0 || !GateEvent(ClassFrame, LevelDebug) {
		return
	}
	var request any
	if record.Request != 0 {
		request = strconv.FormatUint(record.Request, 10)
	}
	EmitHost(LevelDebug, "host.frame.record", map[string]any{
		"window": w.window, "start_ns": strconv.FormatUint(record.Start, 10), "request_ns": request,
		"end_ns": strconv.FormatUint(record.End, 10), "damage": record.Damage, "nodes": record.Nodes,
		"drawable_wait_ns": strconv.FormatUint(record.DrawableWait, 10), "outcome": record.Outcome,
		"command_buffer": record.CommandBuffer, "asks_frame": record.AsksFrame, "animates": record.Animates,
		"repaints": record.Repaints, "timer": record.Timer,
	})
}

// Commit counts one command buffer committed outside a frame and writes its record. kind is stashed, offscreen or pixels.
func (w *WindowFrames) Commit(kind string, at uint64) {
	w.commandBuffers.Add(1)
	if at == 0 || !GateEvent(ClassFrame, LevelDebug) {
		return
	}
	EmitHost(LevelDebug, "host.frame.commit", map[string]any{"window": w.window, "kind": kind, "commit_ns": strconv.FormatUint(at, 10)})
}

// OnSettled runs notify when the report of a frame changes whether the window settled.
func (w *WindowFrames) OnSettled(notify func()) { w.onSettled.Store(&notify) }

// Counters reads the counters of host.window. A window that drew no frame has counted none, and has not settled.
func (w *WindowFrames) Counters() WindowFrameCounters {
	frames, commandBuffers := w.frames.Load(), w.commandBuffers.Load()
	settled := w.settled.Load() == settledYes
	return WindowFrameCounters{Frames: &frames, CommandBuffers: &commandBuffers, Settled: &settled}
}

// Nodes reads the number of nodes of the last build pass of the window.
func (w *WindowFrames) Nodes() int64 { return w.nodes.Load() }

// SetNativeViews stores the number of native view elements that the last placement of the window showed. The placement runs on the
// thread of the frame, and diagnostics.objects reads the number on a goroutine of its own.
func (w *WindowFrames) SetNativeViews(count int64) { w.nativeViews.Store(count) }

// NativeViews reads the number of native view elements that the last placement of the window showed.
func (w *WindowFrames) NativeViews() int64 { return w.nativeViews.Load() }
