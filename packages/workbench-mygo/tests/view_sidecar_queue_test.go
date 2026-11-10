package workbench_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The public view-call already passed the source ingress fence when it queues.
// Ending A and mounting B before that queue starts must cancel A's queued send;
// suppressing only its eventual reply cannot undo a sidecar operation.
func TestQueuedRetiredViewSidecarSendNeverReachesHostHandlerAfterReplacement(t *testing.T) {
	gate := newGate()
	t.Cleanup(gate.open)
	entered := make(chan string, 4)
	stored := &surfaceHost{calls: map[string]workbench.HostCall{
		"viewSidecarSend": func(_ context.Context, argument json.RawMessage) (any, error) {
			var request struct {
				Body struct {
					Operation string `json:"operation"`
				} `json:"body"`
			}
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			entered <- request.Body.Operation
			if request.Body.Operation == "blocking" {
				gate.wait()
			}
			return nil, nil
		},
	}}
	f := surfaceShellOn(t, installedDocument, stored)
	var surface string
	for id, row := range stored.lastSurfaces(t) {
		if row["plugin"] == "textprobe" {
			surface = id
			break
		}
	}
	if surface == "" {
		t.Fatal("fixture has no declared textprobe view")
	}
	send := func(generation, id uint64, operation string) {
		f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "textprobe", "generation": generation, "id": id,
			"command": "runtime.sidecar.send", "params": map[string]any{"sidecar": "@scope/sidecar-probe", "id": surface, "body": map[string]string{"operation": operation}, "cids": []string{}}}})
	}
	send(1, 1, "blocking")
	// The first ordered host handler enters and then waits for the gate, which only the test opens.
	f.pending.until(t, func() bool { return len(entered) > 0 })
	if got := <-entered; got != "blocking" {
		t.Fatalf("wrong first handler: %q", got)
	}
	send(1, 2, "retired-A")
	f.shell.Event("view-process-ended", []any{map[string]any{"surface": surface, "generation": uint64(1)}})
	send(2, 3, "current-B")
	gate.open()
	f.pending.drain(t)
	got := []string{}
	for {
		select {
		case operation := <-entered:
			got = append(got, operation)
		default:
			if !reflect.DeepEqual(got, []string{"current-B"}) {
				t.Fatalf("ordered handlers after source retirement=%v; want only current-B, never a queued retired-A operation", got)
			}
			return
		}
	}
}
