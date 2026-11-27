package workbench_test

import (
	"testing"
)

// core.grid reports the newest unclosed notice of each card as notice, and its status is null while the notice shows
// (docs/spec/notifications.md#notices).
func TestTheGridReportsTheCardNoticeAndNoStatusWhileItShows(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	card := f.tabbedCards()[0]
	if err := f.finish("core.notices.add", map[string]any{"card": card, "kind": "warning", "title": "Careful"}); err != nil {
		t.Fatal(err)
	}
	f.settle()
	grid := f.gridCards()[card]
	notice, _ := grid["notice"].(map[string]any)
	if notice == nil || notice["title"] != "Careful" || notice["kind"] != "warning" || notice["id"] == "" {
		t.Fatalf("the grid notice of the card is %v, want the warning Careful", grid["notice"])
	}
	if grid["status"] != nil {
		t.Fatalf("the grid status is %v while a notice shows, want null", grid["status"])
	}
}

// The card status line shows its newest unclosed notice as the element core.card.notice, and the close control of the line
// closes it, which returns the footer text (docs/spec/notifications.md#notices).
func TestTheCardStatusLineShowsItsNoticeAndCloseRemovesIt(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	card := f.tabbedCards()[0]
	if err := f.finish("core.notices.add", map[string]any{"card": card, "kind": "warning", "title": "Careful"}); err != nil {
		t.Fatal(err)
	}
	f.settle()
	if !f.has("core.card.notice", card) || !f.tester.HasText("Careful") {
		t.Fatal("the card status line shows no notice of the card")
	}
	id := f.gridCards()[card]["notice"].(map[string]any)["id"].(string)
	f.run(t, "core.notices.close", `{"id":"`+id+`"}`)
	f.settle()
	if f.has("core.card.notice", card) {
		t.Fatal("the card status line still shows the closed notice")
	}
}
