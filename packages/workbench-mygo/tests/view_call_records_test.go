package workbench_test

import (
	"context"
	"encoding/json"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// A call that is in flight when its surface closes gets no reply: closing the surface ends its calls, so the canceled host call of
// the call reaches neither the view nor the error display (docs/spec/native-surfaces.md#view-surfaces).
func TestACallInFlightWhenItsSurfaceClosesGetsNoReply(t *testing.T) {
	gate := newGate()
	stored := &surfaceHost{}
	stored.calls = map[string]workbench.HostCall{"exposureRegister": func(ctx context.Context, _ json.RawMessage) (any, error) {
		gate.wait()
		return nil, ctx.Err()
	}}
	f := surfaceShellOn(t, installedDocument, stored)
	f.run("core.card.split", map[string]string{"card": f.tabbedCards()[0], "side": "right", "plugin": "textprobe"})
	card := f.tabbedCards()[len(f.tabbedCards())-1]
	surface := f.activeOf(card)
	f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "textprobe", "generation": 1, "id": 5,
		"command": "runtime.native.call", "params": map[string]any{"name": "registered",
			"payload": map[string]any{"kind": "element", "name": "textprobe.view"}}}})
	f.pending.drain(t)
	replies := len(stored.replies)
	f.click("core.card.close", card)
	gate.open()
	f.settle()
	for _, reply := range stored.replies[replies:] {
		if reply["surface"] == surface {
			t.Fatalf("the closed surface got the reply %v", reply)
		}
	}
}

// viewCallRecords returns the fields of the view call records that the shell wrote, by event name.
func viewCallRecords(stored *surfaceHost) map[string][]map[string]any {
	records := map[string][]map[string]any{}
	for _, name := range []string{"workbench.view.call", "workbench.view.reply", "workbench.view.call.cancel"} {
		for _, event := range stored.written(name) {
			records[name] = append(records[name], event["fields"].(map[string]any))
		}
	}
	return records
}

// The workbench writes workbench.view.call when it accepts a view call and workbench.view.reply when it sent the reply, and the
// reply names the start of the workbench as its page, as the main page names its page identity (docs/spec/native-surfaces.md,
// call records).
func TestAViewCallIsRecordedAndItsReplyNamesTheStart(t *testing.T) {
	f, stored := surfaceShell(t)
	f.followCalls()
	f.settle()
	surface := anySurface(t, stored)
	reply := viewCall(t, f, stored, surface, "composition.declaration", nil)
	start := status[struct {
		Start string `json:"start"`
	}](t, f, "core.window.workbench").Start
	if start == "" || reply["page"] != start {
		t.Fatalf("the reply names the page %v, the start is %q", reply["page"], start)
	}
	records := viewCallRecords(stored)
	calls, replies := records["workbench.view.call"], records["workbench.view.reply"]
	if len(calls) != 1 || len(replies) != 1 || len(records["workbench.view.call.cancel"]) != 0 {
		t.Fatalf("the shell recorded %v", records)
	}
	want := map[string]any{"plugin": "textprobe", "surface": surface, "generation": float64(1), "id": float64(5)}
	for key, value := range want {
		if calls[0][key] != value || replies[0][key] != value {
			t.Fatalf("the records %v and %v do not name %s %v", calls[0], replies[0], key, value)
		}
	}
	if calls[0]["command"] != "composition.declaration" || replies[0]["outcome"] != "result" {
		t.Fatalf("the records are %v and %v", calls[0], replies[0])
	}
	for _, event := range append(stored.written("workbench.view.call"), stored.written("workbench.view.reply")...) {
		if event["start"] != start {
			t.Fatalf("the record %v names another start than %q", event, start)
		}
	}
}

// A call that fails replies with an error, and its reply record names the outcome error.
func TestAFailedViewCallRecordsTheOutcomeError(t *testing.T) {
	f, stored := surfaceShell(t)
	f.followCalls()
	f.settle()
	viewCall(t, f, stored, anySurface(t, stored), "runtime.nothing", nil)
	replies := viewCallRecords(stored)["workbench.view.reply"]
	if len(replies) != 1 || replies[0]["outcome"] != "error" {
		t.Fatalf("the reply records are %v", replies)
	}
}

// A call of a surface that the workbench no longer holds gets no reply, and the workbench records its cancellation.
func TestACallOfAClosedSurfaceIsRecordedAsCancelled(t *testing.T) {
	f, stored := surfaceShell(t)
	f.followCalls()
	f.settle()
	f.shell.Event("view-call", []any{map[string]any{"surface": "tab-gone", "plugin": "textprobe", "generation": 1, "id": 9,
		"command": "tab.title", "params": "x"}})
	f.settle()
	records := viewCallRecords(stored)
	cancels := records["workbench.view.call.cancel"]
	if len(cancels) != 1 || len(records["workbench.view.call"]) != 0 || len(records["workbench.view.reply"]) != 0 {
		t.Fatalf("the shell recorded %v", records)
	}
	if cancels[0]["surface"] != "tab-gone" || cancels[0]["id"] != float64(9) || cancels[0]["generation"] != float64(1) ||
		cancels[0]["command"] != "tab.title" || cancels[0]["plugin"] != "textprobe" {
		t.Fatalf("the cancellation record is %v", cancels[0])
	}
}
