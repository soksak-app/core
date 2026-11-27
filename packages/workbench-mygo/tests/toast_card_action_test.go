package workbench_test

import (
	"testing"
)

// A warning of a card that does not have the focus shows as a toast with the action 카드로 가기, which focuses the card
// (docs/spec/notifications.md#toasts).
func TestAWarningOfAnUnfocusedCardOffersTheCardFocusAction(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	card := f.tabbedCards()[0]
	// The layout focuses its first card, so the focus is cleared first (a nil card clears it, docs/spec/groups.md#focus).
	if err := f.finish("core.card.focus", map[string]any{"card": nil}); err != nil {
		t.Fatal(err)
	}
	if err := f.finish("core.notices.add", map[string]any{"card": card, "kind": "warning", "title": "Careful"}); err != nil {
		t.Fatal(err)
	}
	f.settle()
	if !f.tester.HasText("카드로 가기") {
		t.Fatalf("the toast of the unfocused card offers no 카드로 가기: %q", f.tester.Texts())
	}
}

// The focused card shows no toast for its warning, so the action has no toast to appear on.
func TestAWarningOfTheFocusedCardOffersNoCardFocusAction(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	card := f.tabbedCards()[0]
	if err := f.finish("core.card.focus", map[string]any{"card": card}); err != nil {
		t.Fatal(err)
	}
	if err := f.finish("core.notices.add", map[string]any{"card": card, "kind": "warning", "title": "Careful"}); err != nil {
		t.Fatal(err)
	}
	f.settle()
	if f.tester.HasText("카드로 가기") {
		t.Fatalf("the toast of the focused card offers 카드로 가기: %q", f.tester.Texts())
	}
}
