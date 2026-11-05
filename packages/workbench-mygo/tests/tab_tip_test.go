// The tip of a tab: it shows as the pointer rests on the tab, and goes as the pointer leaves it.
package workbench_test

import (
	"testing"
	"time"
)

const tabTipName = "notes.md"

func tabTipCount(f *tabApp) int {
	count := 0
	for _, text := range f.tester.Texts() {
		if text == tabTipName {
			count++
		}
	}
	return count
}

// tabWithTip opens two tabs, rests the pointer on the named one until its tip shows, and returns the point of the tab and how
// many times the name shows without the tip.
func tabWithTip(t *testing.T) (f *tabApp, x, y float32, shown int) {
	t.Helper()
	stored := &surfaceHost{}
	stored.installed = unloadDocument
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}
	f = newTabApp(t, stored, unloadDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	f.app.Emit(f.window, "view-call", map[string]any{"surface": "tab-aaaaaa", "plugin": "notes", "generation": 1, "id": 5, "command": "tab.title", "params": tabTipName})
	f.settle()
	rect, ok := f.tester.Find(tabTipName)
	if !ok {
		t.Fatalf("no tab with the name in %q", f.tester.Texts())
	}
	x, y = rect.X+rect.W/2, rect.Y+rect.H/2
	shown = tabTipCount(f)
	f.tester.Move(x, y)
	f.tester.Advance(700 * time.Millisecond)
	if got := tabTipCount(f); got != shown+1 {
		t.Fatalf("the tip does not show on the tab: %d, then %d", shown, got)
	}
	return f, x, y, shown
}

func TestAMoveOffATabClosesItsTip(t *testing.T) {
	f, x, y, shown := tabWithTip(t)
	f.tester.Move(x, y+200)
	f.tester.Advance(16 * time.Millisecond)
	if got := tabTipCount(f); got != shown {
		t.Fatalf("the tip stays after the pointer left the tab: %d, not %d", got, shown)
	}
}

// A press takes the tip away, and the pointer that leaves afterwards leaves none.
func TestAMoveOffAPressedTabLeavesNoTip(t *testing.T) {
	f, x, y, shown := tabWithTip(t)
	f.tester.ClickAt(x, y)
	f.settle()
	f.tester.Move(x, y+200)
	f.tester.Advance(700 * time.Millisecond)
	if got := tabTipCount(f); got != shown {
		t.Fatalf("a tip shows after the press and the move: %d, not %d", got, shown)
	}
}

// A tab that a command adds under a pointer that stands elsewhere shows no tip.
func TestANewTabShowsNoTipWithThePointerElsewhere(t *testing.T) {
	f, x, y, shown := tabWithTip(t)
	f.tester.Move(x, y+200)
	f.tester.Advance(16 * time.Millisecond)
	f.command("core.tab.select", map[string]string{"tab": "tab-bbbbbb"})
	f.tester.Advance(700 * time.Millisecond)
	if got := tabTipCount(f); got != shown {
		t.Fatalf("a tip shows without the pointer: %d, not %d", got, shown)
	}
}
