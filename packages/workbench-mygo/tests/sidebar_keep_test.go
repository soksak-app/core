// A window sidebar that its switch hides keeps its section surfaces as hidden surfaces, and the frame after the press draws the plane
// before the settings write answers (docs/spec/plugins.md#sections, docs/spec/external-sidebars.md#window-controls).
package workbench_test

import (
	"strings"
	"testing"
)

// leftSections returns the section surfaces of the left window sidebar of the last placement, with whether each is visible.
func leftSections(t *testing.T, stored *surfaceHost) map[string]bool {
	t.Helper()
	sections := map[string]bool{}
	for id, surface := range stored.lastSurfaces(t) {
		if strings.Contains(id, "/left/") {
			sections[id] = surface["visible"] == true
		}
	}
	return sections
}

// declaredTimes counts the compositionDeclare calls of the surface: the host takes the composition of a new view once.
func declaredTimes(stored *surfaceHost, id string) int {
	times := 0
	for _, declared := range stored.declared {
		if declared == id {
			times++
		}
	}
	return times
}

// A hide and a show of the left window sidebar keep its section surfaces: every placement holds them, hidden while the switch is off,
// and the host takes no new composition for them, so it ends no view and starts none.
func TestASwitchedWindowSidebarKeepsItsSectionSurfaces(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	shown := leftSections(t, stored)
	if len(shown) != 2 {
		t.Fatalf("the left sidebar places the sections %v, want the tree and the bookmarks", shown)
	}
	for id, visible := range shown {
		if !visible || declaredTimes(stored, id) != 1 {
			t.Fatalf("the section %s stands visible %t, declared %d times", id, visible, declaredTimes(stored, id))
		}
	}
	f.click("core.chrome.left", "")
	f.settle()
	if f.has("core.sidebar.status", "left") {
		t.Fatal("the left sidebar still stands")
	}
	hidden := leftSections(t, stored)
	for id := range shown {
		if visible, held := hidden[id]; !held || visible {
			t.Fatalf("with the switch off the placement holds the sections %v, want %s hidden", hidden, id)
		}
	}
	f.click("core.chrome.left", "")
	f.settle()
	element(t, f.tester, "core.sidebar.status", "left")
	again := leftSections(t, stored)
	for id := range shown {
		if !again[id] {
			t.Fatalf("after the show the placement holds the sections %v, want %s visible", again, id)
		}
		if times := declaredTimes(stored, id); times != 1 {
			t.Fatalf("the host took the composition of %s %d times, so it made a new view", id, times)
		}
	}
}

// An arrangement that closes and inserts the window sidebars again keeps the section surfaces of a sidebar that stays.
func TestAnArrangementKeepsTheSectionsOfTheSidebarThatStays(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	shown := leftSections(t, stored)
	placements := len(stored.requests)
	f.click("core.chrome.right", "")
	f.settle()
	if f.has("core.sidebar.status", "right") {
		t.Fatal("the right sidebar still stands")
	}
	for _, request := range stored.requests[placements:] {
		held := map[string]bool{}
		for _, item := range request["surfaces"].([]any) {
			surface := item.(map[string]any)
			held[surface["id"].(string)] = surface["visible"] == true
		}
		for id := range shown {
			if !held[id] {
				t.Fatalf("a placement of the arrangement holds %v, want %s visible", held, id)
			}
		}
	}
	for id := range shown {
		if times := declaredTimes(stored, id); times != 1 {
			t.Fatalf("the host took the composition of %s %d times", id, times)
		}
	}
}

// The frame after the press of a switch draws the plane without the sidebar and presents its placement, with the hidden sections,
// while the host has not answered the settings write; the command answers after the write.
func TestTheSwitchDrawsThePlaneBeforeTheSettingsWriteAnswers(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	shown := leftSections(t, stored)
	writes, presented := len(stored.settings), stored.placed
	release := newGate()
	stored.holdWorkspace = release
	f.click("core.chrome.left", "")
	f.settle()
	if len(stored.settings) != writes {
		t.Fatalf("the host wrote the settings %v before the release", stored.settings[writes:])
	}
	if f.has("core.sidebar.status", "left") {
		t.Fatal("the frame after the press still draws the left sidebar while the settings write runs")
	}
	if stored.placed == presented {
		t.Fatal("no placement presented while the settings write runs")
	}
	hidden := leftSections(t, stored)
	for id := range shown {
		if visible, held := hidden[id]; !held || visible {
			t.Fatalf("the placement before the settings write holds the sections %v, want %s hidden", hidden, id)
		}
	}
	release.open()
	f.settle()
	if len(stored.settings) != writes+1 || stored.settings[writes]["patch"].(map[string]any)["left"] != false {
		t.Fatalf("the host wrote the settings %v, want left false", stored.settings[writes:])
	}
}
