package workbench_test

import (
	"strings"
	"testing"
)

func TestViewCallFollowsTheTextScale(t *testing.T) {
	f, stored := surfaceShell(t)
	for surface := range stored.lastSurfaces(t) {
		if reply := viewCall(t, f, stored, surface, "runtime.textSize.on", nil); reply["error"] != nil {
			t.Fatalf("the reply is %v", reply)
		}
	}
	f.run("core.text.larger", nil)
	f.settle()
	if pushed := strings.Join(stored.hostName, "\n"); strings.Count(pushed, `"event":"textSize"`) != 1 {
		t.Fatalf("the views received %s, want the event textSize for the view of the focused card", pushed)
	}
}

func TestViewCallClipboardReadsAndWritesText(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := anySurface(t, stored)
	if reply := viewCall(t, f, stored, surface, "runtime.clipboard.read", "text"); reply["result"] != nil || reply["error"] != nil {
		t.Fatalf("an empty clipboard answered %v, want null", reply)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.clipboard.writeText", "copied"); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.clipboard.read", "text"); reply["result"] != "copied" {
		t.Fatalf("the reply is %v, want the text that was written", reply)
	}
}

func TestViewCallClipboardRefusesAnotherType(t *testing.T) {
	f, stored := surfaceShell(t)
	reply := viewCall(t, f, stored, anySurface(t, stored), "runtime.clipboard.read", "rtf")
	failure, _ := reply["error"].(map[string]any)
	if failure == nil || failure["message"] != "view call runtime.clipboard.read rtf is not served" {
		t.Fatalf("the reply is %v", reply)
	}
}

func TestViewCallRecordsItsFocus(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := anySurface(t, stored)
	if reply := viewCall(t, f, stored, surface, "tab.focus", map[string]any{"name": "input", "index": 0}); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
	if reply := viewCall(t, f, stored, surface, "tab.focus", "input"); reply["error"] == nil {
		t.Fatalf("a focus of another form answered %v", reply)
	}
}

func TestViewCallFollowsTheLogLevels(t *testing.T) {
	f, stored := surfaceShell(t)
	if reply := viewCall(t, f, stored, anySurface(t, stored), "runtime.log.levels.on", nil); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
}
