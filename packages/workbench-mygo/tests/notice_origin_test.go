package workbench_test

import (
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// A show from an origin that holds a shown notice of the same kind and title rewrites the notice and adds no count
// (docs/spec/notifications.md#notices).
func TestAShowFromTheSameOriginRewritesTheNoticeWithoutACount(t *testing.T) {
	store := workbench.NewShownErrors(func(string) {})
	source := workbench.NoticeSource{Kind: "core"}
	first := store.NotifyFrom("origin-a", workbench.NoticeFields{Kind: "warning", Title: "Outdated", Text: "v1"}, source)
	second := store.NotifyFrom("origin-a", workbench.NoticeFields{Kind: "warning", Title: "Outdated", Text: "v2"}, source)
	entries := store.EntryStatuses()
	if second != first || len(entries) != 1 {
		t.Fatalf("the repeated show made %d entries with id %s, want one entry %s", len(entries), second, first)
	}
	if entries[0]["text"] != "v2" || entries[0]["count"] != 1 {
		t.Fatalf("the entry is %v, want text v2 with count 1", entries[0])
	}
}

// A redraw of an occurrence that the person closed leaves it closed: the entry is rewritten and no toast opens (docs/spec/notifications.md#notices).
func TestAShowFromAClosedOriginRewritesTheEntryAndOpensNoToast(t *testing.T) {
	store := workbench.NewShownErrors(func(string) {})
	source := workbench.NoticeSource{Kind: "core"}
	first := store.NotifyFrom("origin-a", workbench.NoticeFields{Kind: "warning", Title: "Outdated", Text: "v1"}, source)
	if !store.CloseNotice(first) {
		t.Fatal("the notice was not closed")
	}
	store.NotifyFrom("origin-a", workbench.NoticeFields{Kind: "warning", Title: "Outdated", Text: "v2"}, source)
	if toasts := store.ToastStatuses(); len(toasts) != 0 {
		t.Fatalf("a closed occurrence opened a toast again: %+v", toasts)
	}
	entries := store.EntryStatuses()
	if len(entries) != 1 || entries[0]["text"] != "v2" {
		t.Fatalf("the entries are %v, want one entry with text v2", entries)
	}
}
