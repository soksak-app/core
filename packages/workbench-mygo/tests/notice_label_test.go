package workbench_test

import (
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// A card entry keeps the title of its tab as the label of its source, which the source chip shows (docs/spec/notifications.md#notice-center).
// The fixture tab of the plugin textprobe has the title 터미널.
func TestACardEntryKeepsTheTitleOfItsTabAsItsLabel(t *testing.T) {
	f := sidebarShell(t)
	card := f.tabbedCards()[0]
	if err := f.finish("core.notices.add", map[string]any{"card": card, "kind": "info", "title": "Labelled"}); err != nil {
		t.Fatal(err)
	}
	entry := entryTitled(t, f, "Labelled")
	if entry.Source["label"] != "터미널" {
		t.Fatalf("the source is %+v, want the label 터미널 of its tab", entry.Source)
	}
}

// notices.json of the earlier format is refused, and the error names the file and the format it found (docs/spec/notifications.md#notice-center).
func TestNoticesOfTheEarlierFormatAreRefusedByName(t *testing.T) {
	errors := workbench.NewShownErrors(func(string) {})
	err := errors.RestoreNotices(map[string]any{"format": 1, "notices": []any{}})
	if want := `notices.json holds no notices of format 2: {"format":1,"notices":[]}`; err == nil || err.Error() != want {
		t.Fatalf("the format 1 document returned %v, want %q", err, want)
	}
}

// A card entry without its tab label is refused by name (docs/spec/notifications.md#notice-center).
func TestACardNoticeWithoutItsLabelIsRefusedByName(t *testing.T) {
	errors := workbench.NewShownErrors(func(string) {})
	err := errors.RestoreNotices(map[string]any{"format": 2, "notices": []any{map[string]any{
		"id": "notice-1", "kind": "info", "title": "Unlabelled", "text": "", "source": map[string]any{"kind": "card", "card": "card-a", "tab": "tab-a"},
		"actions": []any{}, "at": "2026-11-27T10:00:00+09:00", "count": 1, "read": false}}})
	if want := "notices.json: notice notice-1 is a card notice without its tab label"; err == nil || err.Error() != want {
		t.Fatalf("the unlabelled card notice returned %v, want %q", err, want)
	}
}
