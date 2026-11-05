package adapter

// The frame reports of the workbench of a window (docs/spec/hosts.md#framework-changes, U7).

import (
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
