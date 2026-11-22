package workbench_test

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// programsDocument is installedDocument with the program probe-tool, which takes one argument that equals a, declared by textprobe.
func programsDocument() string {
	return strings.Replace(installedDocument, `"data": {"notes"`, `"programs": {"probe-tool": {"program": "probe-tool", "args": ["a"]}}, "data": {"notes"`, 1)
}

// A view runs a declared program through programRun with its surface, the identifier of the view call, the name and the arguments, and
// replies the host answer (docs/spec/native-surfaces.md#program-runs).
func TestAViewRunsADeclaredProgramThroughProgramRun(t *testing.T) {
	f, stored := surfaceShellOf(t, programsDocument())
	f.followCalls()
	f.settle()
	surface := anySurface(t, stored)
	reply := viewCall(t, f, stored, surface, "runtime.program.run", map[string]any{"name": "probe-tool", "args": []string{"a"}})
	if reply["error"] != nil {
		t.Fatalf("the program run was refused: %v", reply["error"])
	}
	want := map[string]any{"code": float64(0), "stdout": "ok", "stderr": "", "truncated": map[string]any{"stdout": false, "stderr": false}}
	if !reflect.DeepEqual(reply["result"], want) {
		t.Fatalf("the reply is %v, want %v", reply["result"], want)
	}
	wantRun := map[string]any{"surface": surface, "id": float64(5), "name": "probe-tool", "args": []any{"a"}}
	if len(stored.programRuns) != 1 || !reflect.DeepEqual(stored.programRuns[0], wantRun) {
		t.Fatalf("programRun received %v, want one run %v", stored.programRuns, wantRun)
	}
}

// A run without arguments sends an empty list, and a call whose name or arguments are not valid runs nothing and replies the refusal.
func TestAProgramRunRefusesAnInvalidCallAndRunsNothing(t *testing.T) {
	f, stored := surfaceShellOf(t, programsDocument())
	f.followCalls()
	f.settle()
	surface := anySurface(t, stored)
	for _, tc := range []struct {
		params  any
		message string
	}{
		{map[string]any{"name": "", "args": []string{}}, "requires a non-empty name"},
		{map[string]any{"name": "probe-tool", "args": []any{float64(1)}}, "args must be an array of texts"},
		{map[string]any{"name": "probe-tool", "args": "a"}, "args must be an array of texts"},
		{map[string]any{"name": "probe-tool", "args": nil}, "args must be an array of texts"},
	} {
		reply := viewCall(t, f, stored, surface, "runtime.program.run", tc.params)
		if reply["error"] == nil || !strings.Contains(fmt.Sprint(reply["error"]), tc.message) {
			t.Fatalf("params %v: the reply is %v, want the refusal %q", tc.params, reply["error"], tc.message)
		}
	}
	if len(stored.programRuns) != 0 {
		t.Fatalf("a refused call ran %v", stored.programRuns)
	}
}

// The sync request of a view carries the programs that its plugin declares, so the host checks each run against them.
func TestTheSyncRequestDeclaresTheProgramsOfAView(t *testing.T) {
	f, stored := surfaceShellOf(t, programsDocument())
	f.followCalls()
	f.settle()
	surface := anySurface(t, stored)
	got := stored.lastSurfaces(t)[surface]["programs"]
	want := map[string]any{"probe-tool": map[string]any{"program": "probe-tool", "args": []any{"a"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("the sync request declares programs %v, want %v", got, want)
	}
}

// The cancel of an open run sends programCancel with the surface and the identifier of the view call, and the view replies cancelled.
func TestTheCancelOfAnOpenProgramRunSendsProgramCancel(t *testing.T) {
	f, stored := surfaceShellOf(t, programsDocument())
	f.followCalls()
	f.settle()
	surface := anySurface(t, stored)
	stored.programGate = newGate()
	defer stored.programGate.open()
	f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "textprobe", "generation": 1, "id": 5,
		"command": "runtime.program.run", "params": map[string]any{"name": "probe-tool", "args": []string{"a"}}}})
	f.settle()
	f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "textprobe", "generation": 1, "id": 5, "cancel": true}})
	f.settle()
	want := map[string]any{"surface": surface, "id": float64(5)}
	if len(stored.programCancels) != 1 || !reflect.DeepEqual(stored.programCancels[0], want) {
		t.Fatalf("programCancel received %v, want one cancel %v", stored.programCancels, want)
	}
}
