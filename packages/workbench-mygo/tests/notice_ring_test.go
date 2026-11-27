package workbench_test

import "testing"

// The turning ring of a progress entry of the notice center is drawn as the element core.notices.ring, which the window check samples
// by its rectangle (docs/spec/exposure.md). The ring stands inside its entry.
func TestProgressEntryDrawsItsRingAsAnElement(t *testing.T) {
	f, _ := centerShell(t, nil)
	if err := f.finish("core.notices.toggle", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "progress", "title": "Sync"}); err != nil {
		t.Fatal(err)
	}
	id := entryTitled(t, f, "Sync").ID
	f.settle()
	tree := f.elementTree()
	entry, ok := exposedNode(tree, "core.notices.entry", id)
	if !ok {
		t.Fatalf("the entry %s is not drawn", id)
	}
	ring, ok := exposedNode(tree, "core.notices.ring", id)
	if !ok {
		t.Fatalf("the ring of the progress entry %s is not drawn as core.notices.ring", id)
	}
	if ring.Bounds.W <= 0 || ring.Bounds.H <= 0 {
		t.Fatalf("the ring has no size: %v", ring.Bounds)
	}
	if ring.Bounds.X < entry.Bounds.X || ring.Bounds.Y < entry.Bounds.Y ||
		ring.Bounds.X+ring.Bounds.W > entry.Bounds.X+entry.Bounds.W || ring.Bounds.Y+ring.Bounds.H > entry.Bounds.Y+entry.Bounds.H {
		t.Fatalf("the ring %v is outside its entry %v", ring.Bounds, entry.Bounds)
	}
}

// A press on the ring is a press on its entry: the entry is read, as a press on the rest of the entry reads it.
func TestAPressOnTheRingReadsItsEntry(t *testing.T) {
	f, _ := centerShell(t, nil)
	if err := f.finish("core.notices.toggle", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "progress", "title": "Upload"}); err != nil {
		t.Fatal(err)
	}
	id := entryTitled(t, f, "Upload").ID
	f.settle()
	if entryTitled(t, f, "Upload").Read {
		t.Fatal("the progress entry is read before its press")
	}
	f.click("core.notices.ring", id)
	if !entryTitled(t, f, "Upload").Read {
		t.Fatal("the entry is unread after a press on its ring")
	}
}
