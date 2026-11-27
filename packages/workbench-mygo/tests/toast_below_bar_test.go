package workbench_test

import (
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The toasts start below the drawn title bar row, which grows with the frame text factor, so the row never covers a
// toast and no toast covers the bell (docs/spec/notifications.md#notice-center). A toast keeps the same distance from
// the bottom of the row at every factor.
func TestToastsStartBelowTheScaledTitleBarRow(t *testing.T) {
	below := func(factor float64) (float32, float32) {
		f := noticeShell(t, map[string]any{"textSize": factor}, "first failed")
		tree := f.tester.ElementTree()
		bar, ok := exposedNode(tree, "core.chrome.bar", "")
		if !ok {
			t.Fatal("the title bar is not drawn")
		}
		toast, ok := firstExposed(tree, "core.notices.close")
		if !ok {
			t.Fatal("the error toast is not drawn")
		}
		return toast.Bounds.Y - (bar.Bounds.Y + bar.Bounds.H), bar.Bounds.H
	}
	plain, plainRow := below(1)
	scaled, scaledRow := below(1.5)
	if scaledRow <= plainRow {
		t.Fatalf("the title bar row is %.1f high at factor 1.5 and %.1f at factor 1, want a higher row", scaledRow, plainRow)
	}
	if scaled != plain {
		t.Fatalf("the toast stands %.1f below the title bar row at factor 1.5 and %.1f at factor 1, want the same distance", scaled, plain)
	}
}

// firstExposed returns the first drawn node of the element name, whatever its item.
func firstExposed(nodes []ui.ElementNode, name string) (ui.ElementNode, bool) {
	for _, node := range nodes {
		if key, ok := node.Key.(workbench.Exposed); ok && key.Name == name {
			return node, true
		}
		if found, ok := firstExposed(node.Children, name); ok {
			return found, true
		}
	}
	return ui.ElementNode{}, false
}
