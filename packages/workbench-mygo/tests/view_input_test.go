package workbench_test

import (
	"encoding/json"
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

// The view of a hidden space stays out of the layout: it keeps the scale that it has and follows the layout again when its space returns.
func TestAViewOfAHiddenSpaceKeepsItsTextScale(t *testing.T) {
	f, stored := surfaceShell(t)
	surfaces := []string{}
	for surface := range stored.lastSurfaces(t) {
		surfaces = append(surfaces, surface)
		if reply := viewCall(t, f, stored, surface, "runtime.textSize.on", nil); reply["error"] != nil {
			t.Fatalf("the reply is %v", reply)
		}
	}
	first := f.host.projects[0]["activeSpaceId"].(string)
	f.run("core.space.add", nil)
	f.run("core.text.larger", nil)
	f.settle()
	if pushed := strings.Join(stored.hostName, "\n"); strings.Contains(pushed, `"event":"textSize"`) {
		t.Fatalf("a view of a hidden space received %s", pushed)
	}
	reply := viewCall(t, f, stored, surfaces[0], "runtime.textSize.read", nil)
	if reply["error"] != nil || reply["result"] != 1.0 {
		t.Fatalf("a view of a hidden space reads %v", reply)
	}
	f.run("core.space.activate", map[string]string{"id": first})
	f.run("core.text.larger", nil)
	f.settle()
	if pushed := strings.Join(stored.hostName, "\n"); strings.Count(pushed, `"event":"textSize"`) != 1 {
		t.Fatalf("back in the plane the views received %s", pushed)
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

func TestTheFocusOfAViewIsTheKeyboardFocusOfItsWindow(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := anySurface(t, stored)
	viewCall(t, f, stored, surface, "tab.focus", map[string]any{"name": "input", "index": 0})
	f.shell.Event("window-responder", []any{map[string]any{"owner": "surface", "surface": surface, "document": nil}})
	f.settle()
	value, err := f.shell.Registry().Read("core.focus")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if text := string(encoded); !strings.Contains(text, `"name":"input"`) || !strings.Contains(text, surface) {
		t.Fatalf("core.focus is %s", text)
	}
}

func TestViewCallFollowsTheLogLevels(t *testing.T) {
	f, stored := surfaceShell(t)
	if reply := viewCall(t, f, stored, anySurface(t, stored), "runtime.log.levels.on", nil); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
}
