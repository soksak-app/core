package adapter

// The frame reports of the workbench of a window (docs/spec/hosts.md#framework-changes, U7).

import (
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// frameOutcomes are the names of the outcomes of a frame in the event log.
var frameOutcomes = [...]string{
	ui.FrameTransaction: "transaction", ui.FrameImmediate: "immediate", ui.FrameStashed: "stashed",
	ui.FrameSkipped: "skipped", ui.FrameUndamaged: "undamaged", ui.FrameHeld: "held",
}

// commitKinds are the names of the kinds of a commit outside a frame in the event log.
var commitKinds = [...]string{ui.CommitStashed: "stashed", ui.CommitOffscreen: "offscreen", ui.CommitPixels: "pixels"}

// stepKinds are the names of the kinds of a step in the event log.
var stepKinds = [...]string{mygo.StepSelector: "selector", mygo.StepBlock: "block", mygo.StepCallback: "callback"}

// stepRecord is the record of a step that entered while window, the name of the window with the focus, has the focus.
func stepRecord(step mygo.StepRecord, window string) host.StepRecord {
	return host.StepRecord{
		Window: window, Kind: stepKinds[step.Kind], Callback: step.Callback, Entry: step.Entry, Return: step.Return,
		Forwarded: step.Forwarded, Wait: step.Wait,
	}
}

// RecordSteps has the main thread record its steps until stop returns. The window of a record is stepWindow when the record
// is written, because a step belongs to the main thread and not to a window.
func (f *Framework) RecordSteps(report func(host.StepRecord), lost func(uint64)) func() {
	return mygo.RecordSteps(func(step mygo.StepRecord) { report(stepRecord(step, f.stepWindow())) }, lost)
}

// RegisteredCallbacks is how many callbacks the framework registered through purego, which it never frees.
func (*Framework) RegisteredCallbacks() int64 { return mygo.RegisteredCallbacks() }

// stepWindow is the name of the window with the focus, without one the name of the only open window, otherwise "". A gesture
// that the host delivers does not activate its window.
func (f *Framework) stepWindow() string {
	focused := mygo.FocusedWindow()
	f.mu.Lock()
	defer f.mu.Unlock()
	if frontend := f.frontends[focused]; frontend != nil {
		return frontend.Name()
	}
	if len(f.frontends) == 1 {
		for _, frontend := range f.frontends {
			return frontend.Name()
		}
	}
	return ""
}

// FrameRecorder gives the frame reports of a window to frames. The reports run on the thread that drew the frame.
func FrameRecorder(frames *host.WindowFrames) *ui.FrameRecorder {
	return &ui.FrameRecorder{
		Clock: frames.Clock,
		Frame: func(r *ui.FrameRecord) {
			frames.Frame(&host.FrameRecord{
				Start: r.Start, Request: r.Request, End: r.End, DrawableWait: r.DrawableWait, Damage: r.Damage, Nodes: r.Nodes,
				Outcome: frameOutcomes[r.Outcome], CommandBuffer: r.CommandBuffer,
				AsksFrame: r.AsksFrame, Animates: r.Animates, Repaints: r.Repaints, Timer: r.Timer,
			})
		},
		Commit: func(c ui.CommitRecord) { frames.Commit(commitKinds[c.Kind], c.At) },
	}
}
