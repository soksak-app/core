package workbench_test

import (
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// A card notice merges only within its card, so the same kind and title on two cards are two notices.
func TestCardNoticesMergeOnlyWithinOneCard(t *testing.T) {
	store := workbench.NewShownErrors(func(string) {})
	fields := workbench.NoticeFields{Kind: "warning", Title: "service outdated", Text: "a"}
	store.NotifyFrom("", fields, workbench.NoticeSource{Kind: "card", Card: "card-a", Tab: "tab-a", Plugin: "plugin"})
	store.NotifyFrom("", fields, workbench.NoticeSource{Kind: "card", Card: "card-b", Tab: "tab-b", Plugin: "plugin"})
	toasts := store.ToastStatuses()
	if len(toasts) != 2 {
		t.Fatalf("toasts = %+v, want two notices for two cards", toasts)
	}
	for _, toast := range toasts {
		if toast.Count != 1 {
			t.Fatalf("toast %s count = %d, want 1", toast.ID, toast.Count)
		}
	}
}

// The same card with the same kind and title merges into the shown card notice.
func TestCardNoticesMergeWithinTheSameCard(t *testing.T) {
	store := workbench.NewShownErrors(func(string) {})
	fields := workbench.NoticeFields{Kind: "warning", Title: "service outdated", Text: "a"}
	store.NotifyFrom("", fields, workbench.NoticeSource{Kind: "card", Card: "card-a", Tab: "tab-a", Plugin: "plugin"})
	store.NotifyFrom("", fields, workbench.NoticeSource{Kind: "card", Card: "card-a", Tab: "tab-b", Plugin: "plugin"})
	toasts := store.ToastStatuses()
	if len(toasts) != 1 || toasts[0].Count != 2 {
		t.Fatalf("toasts = %+v, want one notice with count 2", toasts)
	}
}

// A card notice and an app notice have no card in common, so they do not merge.
func TestCardNoticeAndAppNoticeDoNotMerge(t *testing.T) {
	store := workbench.NewShownErrors(func(string) {})
	fields := workbench.NoticeFields{Kind: "warning", Title: "service outdated", Text: "a"}
	store.NotifyFrom("", fields, workbench.NoticeSource{Kind: "core"})
	store.NotifyFrom("", fields, workbench.NoticeSource{Kind: "card", Card: "card-a", Tab: "tab-a", Plugin: "plugin"})
	if toasts := store.ToastStatuses(); len(toasts) != 2 {
		t.Fatalf("toasts = %+v, want two notices", toasts)
	}
}
