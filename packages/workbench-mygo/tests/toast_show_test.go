package workbench_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// An error toast offers 자세히, which opens the notice center at the notice through core.notices.show
// (docs/spec/notifications.md#toasts).
func TestAnErrorToastOffersShowWhichOpensTheCenterAtIt(t *testing.T) {
	f := noticeShell(t, nil, "first failed")
	if !f.tester.HasText("자세히") {
		t.Fatalf("the error toast offers no 자세히: %q", f.tester.Texts())
	}
	f.click("core.notices.action", f.noticeFor("first failed"))
	f.settle()
	if !f.has("core.notices.panel", "") {
		t.Fatal("자세히 did not open the notice center")
	}
}

// core.notices.show refuses an id that no entry has with -32602 and the text that names the id
// (docs/spec/notifications.md#commands-and-statuses).
func TestTheShowCommandRefusesAnIdWithNoEntry(t *testing.T) {
	f := noticeShell(t, nil, "first failed")
	err := f.finish("core.notices.show", map[string]any{"id": "missing"})
	if err == nil || !strings.Contains(err.Error(), "no notice missing exists") {
		t.Fatalf("core.notices.show of a missing id answered %v", err)
	}
}

// core.notices reports shown, the id of the entry that core.notices.show marked, or null while no entry is marked
// (docs/spec/notifications.md#commands-and-statuses).
func TestTheStatusReportsTheShownEntry(t *testing.T) {
	f := noticeShell(t, nil, "first failed", "second failed")
	if got := shownOf(t, f); got != nil {
		t.Fatalf("core.notices reports shown %q before any show, want null", *got)
	}
	id := f.noticeFor("first failed")
	if err := f.finish("core.notices.show", map[string]any{"id": id}); err != nil {
		t.Fatalf("core.notices.show answered %v", err)
	}
	if got := shownOf(t, f); got == nil || *got != id {
		t.Fatalf("core.notices reports shown %v after a show of %s, want that id", got, id)
	}
}

// core.notices.show scrolls the center as little as shows its entry, so the entry stands in the rectangle of the center
// (docs/spec/notifications.md#commands-and-statuses).
func TestShowScrollsTheCenterToTheEntry(t *testing.T) {
	texts := make([]string, 0, 14)
	for i := range 14 {
		texts = append(texts, fmt.Sprintf("failure %02d", i))
	}
	f := noticeShell(t, nil, texts...)
	id := f.noticeFor("failure 00")
	if err := f.finish("core.notices.show", map[string]any{"id": id}); err != nil {
		t.Fatalf("core.notices.show answered %v", err)
	}
	f.settle()
	tree := f.elementTree()
	panel, ok := exposedNode(tree, "core.notices.panel", "")
	if !ok {
		t.Fatal("core.notices.show did not open the center")
	}
	entry, ok := exposedNode(tree, "core.notices.entry", id)
	if !ok {
		t.Fatalf("the entry %s is not drawn", id)
	}
	if !standsIn(
		ui.Rect{X: entry.Bounds.X, Y: entry.Bounds.Y, W: entry.Bounds.W, H: entry.Bounds.H},
		ui.Rect{X: panel.Bounds.X, Y: panel.Bounds.Y, W: panel.Bounds.W, H: panel.Bounds.H},
	) {
		t.Fatalf("the entry %s is at %v, outside the center at %v", id, entry.Bounds, panel.Bounds)
	}
}

// shownOf reads the shown field of core.notices; nil is the null of the status.
func shownOf(t *testing.T, f *tabShell) *string {
	t.Helper()
	var status struct {
		Shown *string `json:"shown"`
	}
	if err := json.Unmarshal([]byte(f.status("core.notices")), &status); err != nil {
		t.Fatalf("core.notices is %s: %v", f.status("core.notices"), err)
	}
	return status.Shown
}
