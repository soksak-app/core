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

// A view of a space off the screen has no card, so it keeps its scale, and it reads that scale. It hears the change when its space shows.
func TestAViewOfAHiddenSpaceKeepsItsTextScale(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	if reply := viewCall(t, f, stored, surface, "runtime.textSize.on", nil); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
	first := f.host.projects[0]["spaces"].([]any)[0].(map[string]any)["id"].(string)
	f.run("core.space.add", nil)
	f.settle()
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"left": false}})
	f.settle()
	if reply := viewCall(t, f, stored, surface, "runtime.textSize.read", nil); reply["error"] != nil || reply["result"] != float64(1) {
		t.Fatalf("the reply is %v", reply)
	}
	f.run("core.settings.set", map[string]any{"scope": "common", "patch": map[string]any{"textSize": 1.25}})
	f.settle()
	count := func() int { return strings.Count(strings.Join(stored.hostName, "\n"), `"event":"textSize"`) }
	if count() != 0 {
		t.Fatalf("a view off the screen received %v", stored.hostName)
	}
	f.run("core.space.activate", map[string]string{"id": first})
	f.settle()
	if count() != 1 {
		t.Fatalf("the view of the shown space received %v", stored.hostName)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.textSize.read", nil); reply["error"] != nil || reply["result"] == float64(1) {
		t.Fatalf("the reply is %v", reply)
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
