package workbench_test

import (
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// A withdrawn error closes its toast and keeps its entry, read, until the entry is cleared (docs/spec/notifications.md#notices).
func TestAWithdrawnErrorKeepsItsEntryUntilCleared(t *testing.T) {
	shown := workbench.NewShownErrors(func(string) {})
	shown.ShowFrom("tab error tab-aaaaaa", "source", "Broken\nthe detail", "")
	if !shown.HideFrom("tab error tab-aaaaaa", "source") {
		t.Fatal("the error was not withdrawn")
	}
	if toasts := shown.ToastStatuses(); len(toasts) != 0 {
		t.Fatalf("the withdrawn error still shows as a toast: %+v", toasts)
	}
	entries := shown.EntryStatuses()
	if len(entries) != 1 || entries[0]["kind"] != "error" || entries[0]["read"] != true {
		t.Fatalf("the entries are %+v, want the withdrawn error, read, as an entry", entries)
	}
	shown.ClearAllNotices()
	if entries := shown.EntryStatuses(); len(entries) != 0 {
		t.Fatalf("the entries after clearing are %+v, want none", entries)
	}
}
