package workbench_test

import (
	"slices"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// A released surface sends its held replies in order and writes the line of the ended hold once the host answered each
// (docs/spec/endpoint.md, diagnostics.surface.hold).
func TestASurfaceReplyHoldSendsTheHeldRepliesAfterItsHoldEnded(t *testing.T) {
	var lines []string
	hold := workbench.NewSurfaceReplyHold(func(line string) { lines = append(lines, line) })
	hold.Released("tab-a")
	if len(lines) != 0 {
		t.Fatalf("the release of a surface without a hold wrote %q", lines)
	}
	if err := hold.Hold("tab-a"); err != nil {
		t.Fatal(err)
	}
	var sends []func()
	var order []string
	hold.Gate("tab-a", func(done func()) { order = append(order, "first"); sends = append(sends, done) })
	hold.Gate("tab-a", func(done func()) { order = append(order, "second"); sends = append(sends, done) })
	hold.Released("tab-a")
	if !slices.Equal(order, []string{"first", "second"}) || len(lines) != 0 {
		t.Fatalf("the released surface sent %q and wrote %q before the host answered", order, lines)
	}
	sends[0]()
	sends[1]()
	want := []string{`held exposure replies of surface "tab-a" were sent after their hold ended (2)`}
	if !slices.Equal(lines, want) {
		t.Fatalf("the hold wrote %q, want %q", lines, want)
	}
	hold.Gate("tab-a", func(done func()) { order = append(order, "after"); done() })
	if !slices.Equal(order, []string{"first", "second", "after"}) {
		t.Fatalf("a reply after the release was held: %q", order)
	}
	if err := hold.Hold("tab-b"); err != nil {
		t.Fatal(err)
	}
	var held []error
	hold.Held("tab-b", func(err error) { held = append(held, err) })
	hold.Released("tab-b")
	if len(held) != 1 || held[0] == nil || held[0].Error() != `the hold of surface "tab-b" ended before it held an exposure reply` {
		t.Fatalf("held of a surface released first answered %v", held)
	}
}

// The host event diagnostics-surface-released ends the hold of its surface, so a later hold of the surface starts.
func TestTheEventDiagnosticsSurfaceReleasedEndsTheHoldOfTheSurface(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	if _, err := r.f.replyOf("diagnostics.surface.hold", `{"surface":"`+surface+`"}`); err != nil {
		t.Fatal(err)
	}
	r.emit("diagnostics-surface-released", map[string]any{"surface": surface})
	r.f.settle()
	if _, err := r.f.replyOf("diagnostics.surface.hold", `{"surface":"`+surface+`"}`); err != nil {
		t.Fatalf("a hold after the release failed with %v", err)
	}
}
