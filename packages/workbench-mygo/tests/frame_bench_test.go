// The cost of one frame of the workbench in a window that holds a full layout.
package workbench_test

import (
	"encoding/json"
	"slices"
	"testing"
	"time"
)

// fullDocument is the installed plugins of the views and of the sections of a window.
func fullDocument(b testing.TB) string {
	b.Helper()
	plugins := []any{}
	for _, document := range []string{installedDocument, sidebarsInstalled} {
		var installed struct{ Plugins []any }
		if err := json.Unmarshal([]byte(document), &installed); err != nil {
			b.Fatal(err)
		}
		for _, plugin := range installed.Plugins {
			if id := plugin.(map[string]any)["id"]; !slices.ContainsFunc(plugins, func(kept any) bool { return kept.(map[string]any)["id"] == id }) {
				plugins = append(plugins, plugin)
			}
		}
	}
	text, err := json.Marshal(map[string]any{"plugins": plugins})
	if err != nil {
		b.Fatal(err)
	}
	return string(text)
}

// fullShell returns a shell with eight tabbed cards, twenty tabs, two sections in a window sidebar and an open picker.
func fullShell(b testing.TB) *shellFixture {
	f, _ := fullShellOf(b)
	return f
}

// fullShellOf is fullShell with the host that stores its surfaces.
func fullShellOf(b testing.TB) (*shellFixture, *surfaceHost) {
	b.Helper()
	f, stored := surfaceShellOf(b, fullDocument(b))
	for len(f.tabbedCards()) < 8 {
		split := false
		for _, card := range f.tabbedCards() {
			for _, side := range []string{"right", "bottom"} {
				if !split {
					_, err := f.answer("core.card.split", map[string]string{"card": card, "side": side, "plugin": "textprobe"})
					split = err == nil
				}
			}
		}
		f.settle()
		if !split {
			b.Fatalf("no card splits: %v", f.tabbedCards())
		}
	}
	cards := f.tabbedCards()
	for added := 0; added < 12; added++ {
		f.run("core.card.add-tab", map[string]string{"card": cards[added%len(cards)], "plugin": "boxprobe"})
	}
	f.run("core.card.tools", map[string]string{"card": cards[0]})
	f.tester.Advance(2 * time.Second) // The strips glide to their new tabs.
	f.settle()
	if !f.has("core.sidebar.section.name", "left/fieldprobe.tree") || !f.has("core.sidebar.section.name", "left/fieldprobe.bookmarks") {
		b.Fatal("the window sidebar shows no two sections")
	}
	if !f.menu().Open {
		b.Fatal("the picker is closed")
	}
	if tabs := len(f.tabbedCards()); tabs != 8 {
		b.Fatalf("the window holds %d cards", tabs)
	}
	return f, stored
}

// readyViews makes the view of each surface of the window report its first call, so no tab shows the turning ring of a loading
// view.
func readyViews(t *testing.T, f *shellFixture, stored *surfaceHost) {
	t.Helper()
	for id, surface := range stored.lastSurfaces(t) {
		f.shell.Event("view-call", []any{map[string]any{"surface": id, "plugin": surface["plugin"], "generation": 1, "id": 5,
			"command": "tab.footer", "params": "ready"}})
	}
	f.settle()
}

// A window at rest asks for no frame: not from its own frame, and not as time passes. A window whose views are all ready is at
// rest; a loading view turns its ring at each display frame.
func TestAWindowAtRestAsksForNoFrame(t *testing.T) {
	f, stored := fullShellOf(t)
	readyViews(t, f, stored)
	f.settle()
	f.tester.Frame()
	f.settle()
	if f.tester.FramePending() {
		t.Fatal("the window asks for a frame after it settled")
	}
	before := f.frames
	f.tester.Frame()
	f.tester.Advance(time.Minute)
	f.settle()
	if f.frames != before || f.tester.FramePending() {
		t.Fatalf("the window asked for %d frames at rest", f.frames-before)
	}
}

// The ring of a loading view turns at each refresh of the display that shows the window, whatever its rate, so the window asks
// for the next display frame and not for a frame after a fixed time; a ready view asks for none.
func TestALoadingViewAsksForEachDisplayFrameUntilItIsReady(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	f.tester.Frame()
	if !f.tester.FramePending() {
		t.Fatal("the turning ring of a loading view asks for no display frame")
	}
	viewCall(t, f, stored, surface, "tab.footer", "ready")
	readyViews(t, f, stored)
	f.tester.Frame()
	f.settle()
	if f.tester.FramePending() {
		t.Fatal("a window whose views are ready asks for a display frame")
	}
}

// A report of what the tab already shows changes nothing on the screen.
func TestAReportOfTheSameValueAsksForNoFrame(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	for _, report := range []struct {
		command string
		value   any
	}{{"tab.title", "zsh"}, {"tab.footer", "short"}, {"tab.directory", "/tmp"}, {"tab.error", "late"}, {"tab.modified", true}} {
		// The first error is recorded by the error display that shows it (docs/spec/plugins.md#tab-reports); the other reports
		// record nothing.
		records := viewCallShowing(t, f, stored, surface, report.command, report.value)
		want := 0
		if report.command == "tab.error" {
			want = 1
		}
		if len(records) != want {
			t.Fatalf("the first %s recorded %q", report.command, records)
		}
		before := f.frames
		viewCall(t, f, stored, surface, report.command, report.value)
		if f.frames != before {
			t.Fatalf("the same %s asked for %d frames", report.command, f.frames-before)
		}
	}
}

// A frame that follows no change.
func BenchmarkAFrameOfAFullWindow(b *testing.B) {
	f := fullShell(b)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		f.tester.Frame()
		for len(f.pending) > 0 {
			(<-f.pending)()
		}
	}
}
