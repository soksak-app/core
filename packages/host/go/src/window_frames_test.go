package host

import (
	"testing"
)

func TestWindowFramesCountEachFrameAndEachCommandBuffer(t *testing.T) {
	frames := NewWindowFrames("main")
	if got := frames.Counters(); *got.Frames != 0 || *got.CommandBuffers != 0 || *got.Settled {
		t.Fatalf("a window that drew nothing reports %d frames, %d command buffers, settled %t", *got.Frames, *got.CommandBuffers, *got.Settled)
	}
	frames.Frame(&FrameRecord{Outcome: "transaction", CommandBuffer: true, Nodes: 5})
	frames.Frame(&FrameRecord{Outcome: "stashed", AsksFrame: true, Nodes: 6})
	frames.Commit("stashed", 0)
	frames.Frame(&FrameRecord{Outcome: "undamaged", Nodes: 7})
	got := frames.Counters()
	if *got.Frames != 3 || *got.CommandBuffers != 2 || !*got.Settled {
		t.Fatalf("counters %d frames, %d command buffers, settled %t, want 3, 2, true", *got.Frames, *got.CommandBuffers, *got.Settled)
	}
	if frames.Nodes() != 7 {
		t.Fatalf("nodes %d, want the 7 of the last frame", frames.Nodes())
	}
}

func TestWindowFramesNotifyOnlyWhenSettledChanges(t *testing.T) {
	frames := NewWindowFrames("main")
	notices := 0
	frames.OnSettled(func() { notices++ })
	moving := &FrameRecord{Outcome: "immediate", Animates: true}
	settled := &FrameRecord{Outcome: "immediate"}
	for _, step := range []struct {
		record *FrameRecord
		want   int
	}{{moving, 1}, {moving, 1}, {settled, 2}, {settled, 2}, {&FrameRecord{Timer: true}, 3}, {&FrameRecord{Repaints: true}, 3}, {&FrameRecord{AsksFrame: true}, 3}, {settled, 4}} {
		frames.Frame(step.record)
		if notices != step.want {
			t.Fatalf("%d notices after %+v, want %d", notices, step.record, step.want)
		}
	}
}

func TestFrameRecordsReachTheClassFrame(t *testing.T) {
	frames := NewWindowFrames("main")
	isolateTraceRecords(t)
	frames.Frame(&FrameRecord{Start: 10, End: 40, Damage: 12, Nodes: 3, Outcome: "undamaged"})
	frames.Frame(&FrameRecord{Start: 50, Request: 60, End: 70, DrawableWait: 5, Damage: 12, Nodes: 3, Outcome: "immediate", CommandBuffer: true, Timer: true})
	frames.Commit("stashed", 80)
	records := bufferedTraces(t, "host.frame.record")
	if len(records) != 2 {
		t.Fatalf("%d frame records, want 2", len(records))
	}
	if records[0]["request_ns"] != nil || records[0]["start_ns"] != "10" || records[0]["outcome"] != "undamaged" {
		t.Fatalf("the record of a frame without a presentation: %v", records[0])
	}
	second := records[1]
	if second["request_ns"] != "60" || second["end_ns"] != "70" || second["drawable_wait_ns"] != "5" || second["command_buffer"] != true || second["timer"] != true {
		t.Fatalf("the record of a frame that presented: %v", second)
	}
	commits := bufferedTraces(t, "host.frame.commit")
	if len(commits) != 1 || commits[0]["kind"] != "stashed" || commits[0]["commit_ns"] != "80" || commits[0]["window"] != "main" {
		t.Fatalf("the commits: %v", commits)
	}
}
