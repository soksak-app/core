package workbench_test

import (
	"image/color"
	"testing"

	"github.com/egoist/mygo/ui"
)

// bellHasColor reports whether a pixel in the top-right corner of the bell has the color want, where the unread count badge stands
// (docs/spec/notifications.md#bell).
func bellHasColor(t *testing.T, f *tabShell, want ui.Color) bool {
	t.Helper()
	node, ok := keyed(f.elementTree(), "core.chrome.notices", "")
	if !ok {
		t.Fatal("the bell is not on the title bar")
	}
	box := node.Bounds
	target := color.RGBA{want.R, want.G, want.B, 255}
	for y := box.Y; y < box.Y+16; y++ {
		for x := box.X + box.W - 16; x < box.X+box.W; x++ {
			if f.pixelOf(x, y) == target {
				return true
			}
		}
	}
	return false
}

// An unread warning or error shows the count of the bell in the error token (docs/spec/notifications.md#bell).
func TestTheBellCountIsTheErrorTokenWhileAProblemIsUnread(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	if err := f.finish("core.notices.add", map[string]any{"card": f.tabbedCards()[0], "kind": "warning", "title": "Careful"}); err != nil {
		t.Fatal(err)
	}
	f.settle()
	if !bellHasColor(t, f, f.palette().No) {
		t.Fatal("the bell count is not in the error token while a warning is unread")
	}
}

// Without an unread problem the bell count is in the accent (docs/spec/notifications.md#bell).
func TestTheBellCountIsTheAccentWithoutAnUnreadProblem(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	if err := f.finish("core.notices.add", map[string]any{"card": f.tabbedCards()[0], "kind": "info", "title": "Done"}); err != nil {
		t.Fatal(err)
	}
	f.settle()
	if bellHasColor(t, f, f.palette().No) {
		t.Fatal("the bell count is in the error token without an unread problem")
	}
	if !bellHasColor(t, f, f.palette().Focus) {
		t.Fatal("the bell count is not in the accent")
	}
}
