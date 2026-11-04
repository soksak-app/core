// The cost of one frame of the workbench in a window that holds a full layout.
package workbench_test

import (
	"encoding/json"
	"slices"
	"testing"
)

// fullDocument is the installed plugins of the views and of the sections of a window.
func fullDocument(b *testing.B) string {
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
func fullShell(b *testing.B) *shellFixture {
	b.Helper()
	f, _ := surfaceShellOf(b, fullDocument(b))
	for len(f.tabbedCards()) < 8 {
		split := false
		for _, card := range f.tabbedCards() {
			for _, side := range []string{"right", "bottom"} {
				if !split {
					_, err := f.answer("core.card.split", map[string]string{"card": card, "side": side, "plugin": "terminal"})
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
		f.run("core.card.add-tab", map[string]string{"card": cards[added%len(cards)], "plugin": "browser"})
	}
	f.run("core.card.tools", map[string]string{"card": cards[0]})
	f.settle()
	if !f.has("core.sidebar.section.name", "left/files.tree") || !f.has("core.sidebar.section.name", "left/files.bookmarks") {
		b.Fatal("the window sidebar shows no two sections")
	}
	if !f.menu().Open {
		b.Fatal("the picker is closed")
	}
	if tabs := len(f.tabbedCards()); tabs != 8 {
		b.Fatalf("the window holds %d cards", tabs)
	}
	return f
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
