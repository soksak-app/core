package workbench_test

import "testing"

type openCallRead struct {
	Plugin          string   `json:"plugin"`
	Count           int      `json:"count"`
	OldestStartedAt *float64 `json:"oldestStartedAt"`
}

type lossRead struct {
	Plugin      string `json:"plugin"`
	Abandoned   int    `json:"abandoned"`
	LateReplies int    `json:"lateReplies"`
	Timeouts    int    `json:"timeouts"`
	PeerLost    int    `json:"peerLost"`
}

type viewRead struct {
	Plugin     string `json:"plugin"`
	Surface    string `json:"surface"`
	Responsive bool   `json:"responsive"`
}

// A command that a view has not answered is an open call of its plugin, and the reply ends it.
func TestACommandOfAViewIsAnOpenCallUntilItsReply(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "textprobe.input"})
	if got := status[[]openCallRead](t, r.f, "core.plugin.open-calls"); len(got) != 0 {
		t.Fatalf("the open calls are %+v before a command", got)
	}
	r.ask(9, "command.run", `{"name": "textprobe.input", "params": {}}`)
	request := r.request(0)
	got := status[[]openCallRead](t, r.f, "core.plugin.open-calls")
	if len(got) != 1 || got[0].Plugin != "textprobe" || got[0].Count != 1 || got[0].OldestStartedAt == nil || *got[0].OldestStartedAt <= 0 {
		t.Fatalf("the open calls are %+v", got)
	}
	r.emit("view-reply", map[string]any{"surface": surface, "plugin": "textprobe", "id": request["id"], "result": nil})
	r.answer(9)
	if got := status[[]openCallRead](t, r.f, "core.plugin.open-calls"); len(got) != 0 {
		t.Fatalf("the open calls are %+v after the reply", got)
	}
}

// The limit of a command counts a timeout, and the reply that follows it counts a late reply.
func TestATimeoutAndALateReplyCountAsLosses(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "textprobe.close"})
	r.ask(9, "command.run", `{"name": "textprobe.close", "params": {}}`)
	request := r.request(0)
	r.answer(9)
	got := status[[]lossRead](t, r.f, "core.plugin.losses")
	if len(got) != 1 || got[0] != (lossRead{Plugin: "textprobe", Timeouts: 1}) {
		t.Fatalf("the losses are %+v", got)
	}
	r.emit("view-reply", map[string]any{"surface": surface, "plugin": "textprobe", "id": request["id"], "result": nil})
	r.f.pending.drain(t)
	got = status[[]lossRead](t, r.f, "core.plugin.losses")
	if len(got) != 1 || got[0] != (lossRead{Plugin: "textprobe", Timeouts: 1, LateReplies: 1}) {
		t.Fatalf("the losses after the late reply are %+v", got)
	}
}

// A surface that closes with a command open loses that command.
func TestASurfaceThatClosesLosesItsOpenCalls(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "textprobe.input"})
	r.ask(9, "command.run", `{"name": "textprobe.input", "params": {}}`)
	r.request(0)
	r.f.run("core.tab.close", map[string]string{"tab": surface})
	r.f.pending.drain(t)
	got := status[[]lossRead](t, r.f, "core.plugin.losses")
	if len(got) != 1 || got[0] != (lossRead{Plugin: "textprobe", PeerLost: 1}) {
		t.Fatalf("the losses are %+v", got)
	}
	if open := status[[]openCallRead](t, r.f, "core.plugin.open-calls"); len(open) != 0 {
		t.Fatalf("the open calls are %+v", open)
	}
}

// A view that ends with a command open is a failure of the view and counts no loss.
func TestAViewThatEndsCountsNoLoss(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "textprobe.input"})
	r.ask(9, "command.run", `{"name": "textprobe.input", "params": {}}`)
	r.request(0)
	r.emit("view-process-ended", map[string]any{"surface": surface, "generation": 1})
	r.answer(9)
	if got := status[[]lossRead](t, r.f, "core.plugin.losses"); len(got) != 0 {
		t.Fatalf("the losses are %+v", got)
	}
}

// The host notices keep the responsiveness of each view until its surface closes.
func TestTheResponsivenessOfAViewFollowsItsNotices(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "textprobe.input"})
	r.emit("view-responsiveness", map[string]any{"surface": surface, "generation": 7, "responsive": false})
	r.f.pending.drain(t)
	if got := status[[]viewRead](t, r.f, "core.plugin.views"); len(got) != 0 {
		t.Fatalf("a notice of another generation gave %+v", got)
	}
	r.emit("view-responsiveness", map[string]any{"surface": surface, "generation": 1, "responsive": false})
	r.f.pending.drain(t)
	got := status[[]viewRead](t, r.f, "core.plugin.views")
	if len(got) != 1 || got[0] != (viewRead{Plugin: "textprobe", Surface: surface, Responsive: false}) {
		t.Fatalf("the views are %+v", got)
	}
	r.emit("view-responsiveness", map[string]any{"surface": surface, "generation": 1, "responsive": true})
	r.f.pending.drain(t)
	if got := status[[]viewRead](t, r.f, "core.plugin.views"); len(got) != 1 || !got[0].Responsive {
		t.Fatalf("the views are %+v", got)
	}
	r.f.run("core.tab.close", map[string]string{"tab": surface})
	r.f.pending.drain(t)
	if got := status[[]viewRead](t, r.f, "core.plugin.views"); len(got) != 0 {
		t.Fatalf("the views are %+v after the close", got)
	}
}

// A notice of another generation than the running view writes that it was left.
func TestANoticeOfAnotherGenerationIsRecorded(t *testing.T) {
	stored := &surfaceHost{}
	stored.classes, stored.common = traceClasses(), map[string]any{"diagnostics.log": traceClasses()}
	r := newViewRelayOn(t, stored)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "textprobe.input"})
	r.emit("view-responsiveness", map[string]any{"surface": surface, "plugin": "textprobe", "generation": 7, "responsive": false})
	r.f.pending.drain(t)
	got := stored.written("workbench.view.event.cancel")
	if len(got) != 1 {
		t.Fatalf("the host received %v", got)
	}
	if fields := got[0]["fields"].(map[string]any); fields["plugin"] != "textprobe" || fields["surface"] != surface || fields["event"] != "view-responsiveness" {
		t.Fatalf("the fields are %v", fields)
	}
}

// A presentation wait that ended without the presentation counts losses.abandoned of the plugin of the surface.
func TestAnAbandonedPresentationCountsALoss(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.emit("view-presentation-abandoned", map[string]any{"surface": surface, "reason": "surface-closed"})
	r.f.pending.drain(t)
	got := status[[]lossRead](t, r.f, "core.plugin.losses")
	if len(got) != 1 || got[0] != (lossRead{Plugin: "textprobe", Abandoned: 1}) {
		t.Fatalf("the losses are %+v", got)
	}
}
