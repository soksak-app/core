package workbench_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// noticeStatus is the value of core.notices as the tests read it.
type noticeStatus struct {
	Open     bool          `json:"open"`
	Style    string        `json:"style"`
	Filter   string        `json:"filter"`
	Unread   int           `json:"unread"`
	Problems bool          `json:"problems"`
	Entries  []noticeEntry `json:"entries"`
}

// noticeEntry is one entry of the center.
type noticeEntry struct {
	ID       string         `json:"id"`
	Kind     string         `json:"kind"`
	Title    string         `json:"title"`
	Text     string         `json:"text"`
	Source   map[string]any `json:"source"`
	Progress *float64       `json:"progress"`
	Count    int            `json:"count"`
	Read     bool           `json:"read"`
}

func noticesOf(t *testing.T, f *shellFixture) noticeStatus {
	t.Helper()
	var status noticeStatus
	if err := json.Unmarshal([]byte(f.status("core.notices")), &status); err != nil {
		t.Fatalf("core.notices is %s: %v", f.status("core.notices"), err)
	}
	return status
}

func entryTitled(t *testing.T, f *shellFixture, title string) noticeEntry {
	t.Helper()
	for _, entry := range noticesOf(t, f).Entries {
		if entry.Title == title {
			return entry
		}
	}
	t.Fatalf("no entry titled %q in %+v", title, noticesOf(t, f).Entries)
	return noticeEntry{}
}

// refusedWith fails the test unless err is the refusal -32602 with the message.
func refusedWith(t *testing.T, err error, message string) {
	t.Helper()
	var refusal *workbench.Refusal
	if !errors.As(err, &refusal) || refusal.Code != workbench.InvalidParams || refusal.Message != message {
		t.Fatalf("the command failed with %v, want the refusal -32602 %q", err, message)
	}
}

func TestAPluginNoticeAddedByCommandIsAnEntryWithItsSource(t *testing.T) {
	f, _ := centerShell(t, nil)
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "info", "title": "Added"}); err != nil {
		t.Fatal(err)
	}
	entry := entryTitled(t, f, "Added")
	if entry.Source["kind"] != "plugin" || entry.Source["plugin"] != "fieldprobe" || entry.Read {
		t.Fatalf("the entry is %+v, want an unread entry of the plugin fieldprobe", entry)
	}
}

func TestAddTakesExactlyOneOfCardAndPlugin(t *testing.T) {
	f, _ := centerShell(t, nil)
	refusedWith(t, f.finish("core.notices.add", map[string]any{"card": "c", "plugin": "fieldprobe", "kind": "info", "title": "Both"}),
		"core.notices.add takes exactly one of card and plugin")
	refusedWith(t, f.finish("core.notices.add", map[string]any{"kind": "info", "title": "Neither"}),
		"core.notices.add takes exactly one of card and plugin")
}

func TestAddRefusesAnUnknownPlugin(t *testing.T) {
	f, _ := centerShell(t, nil)
	refusedWith(t, f.finish("core.notices.add", map[string]any{"plugin": "no-such", "kind": "info", "title": "x"}), "plugin no-such does not exist")
}

func TestAddRefusesAFieldTheNoticeRuleRefuses(t *testing.T) {
	f, _ := centerShell(t, nil)
	refusedWith(t, f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "loud", "title": "x"}),
		"a notice kind must be success, info, warning, error or progress")
}

func TestAddRefusesTheSystemFlagOnThePluginForm(t *testing.T) {
	f, _ := centerShell(t, nil)
	refusedWith(t, f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "info", "title": "y", "system": true}),
		"core.notices.add with plugin takes no system flag; a page of the plugin posts system notices")
}

func TestProgressSetsAProgressNoticeAndRefusesAnOutOfRangeValue(t *testing.T) {
	f, _ := centerShell(t, nil)
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "progress", "title": "Import"}); err != nil {
		t.Fatal(err)
	}
	id := entryTitled(t, f, "Import").ID
	if err := f.finish("core.notices.progress", map[string]any{"id": id, "progress": 0.5}); err != nil {
		t.Fatal(err)
	}
	if got := entryTitled(t, f, "Import").Progress; got == nil || *got != 0.5 {
		t.Fatalf("the progress is %v, want 0.5", got)
	}
	refusedWith(t, f.finish("core.notices.progress", map[string]any{"id": id, "progress": 2}),
		"a notice progress must be a number from 0 to 1, or null while the amount is unknown")
}

func TestDoneEndsAProgressNoticeAndRefusesOtherKinds(t *testing.T) {
	f, _ := centerShell(t, nil)
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "progress", "title": "Export"}); err != nil {
		t.Fatal(err)
	}
	id := entryTitled(t, f, "Export").ID
	if err := f.finish("core.notices.done", map[string]any{"id": id, "kind": "success", "title": "Exported"}); err != nil {
		t.Fatal(err)
	}
	if entry := entryTitled(t, f, "Exported"); entry.Kind != "success" || entry.ID != id {
		t.Fatalf("the entry is %+v, want the ended notice as success", entry)
	}
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "info", "title": "Plain"}); err != nil {
		t.Fatal(err)
	}
	info := entryTitled(t, f, "Plain").ID
	refusedWith(t, f.finish("core.notices.done", map[string]any{"id": info, "kind": "success", "title": "Plain"}), "notice "+info+" is not a progress notice")
}

func TestReadMarksOneEntryAndRefusesAnUnknownId(t *testing.T) {
	f, _ := centerShell(t, nil)
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "info", "title": "Unread"}); err != nil {
		t.Fatal(err)
	}
	id := entryTitled(t, f, "Unread").ID
	if err := f.finish("core.notices.read", map[string]any{"id": id}); err != nil {
		t.Fatal(err)
	}
	if !entryTitled(t, f, "Unread").Read {
		t.Fatal("the entry is not read after core.notices.read")
	}
	refusedWith(t, f.finish("core.notices.read", map[string]any{"id": "notice-unknown"}), "notice notice-unknown is not an entry")
}

func TestReadAllMarksEveryEntryRead(t *testing.T) {
	f, _ := centerShell(t, nil)
	for _, title := range []string{"First", "Second"} {
		if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "info", "title": title}); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.finish("core.notices.read-all", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if status := noticesOf(t, f); status.Unread != 0 || len(status.Entries) != 2 {
		t.Fatalf("the status is %+v, want two read entries", status)
	}
}

func TestStatusCountsUnreadEntriesAndFlagsProblems(t *testing.T) {
	f, _ := centerShell(t, nil)
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "warning", "title": "Careful"}); err != nil {
		t.Fatal(err)
	}
	if status := noticesOf(t, f); status.Unread != 1 || !status.Problems {
		t.Fatalf("the status is %+v, want one unread entry and problems", status)
	}
}

func TestClearRemovesAGroupAndRefusesAGroupThatIsNoDay(t *testing.T) {
	f, _ := centerShell(t, nil)
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "info", "title": "Today"}); err != nil {
		t.Fatal(err)
	}
	if err := f.finish("core.notices.clear", map[string]any{"group": "today"}); err != nil {
		t.Fatal(err)
	}
	if n := len(noticesOf(t, f).Entries); n != 0 {
		t.Fatalf("%d entries remain after clearing today", n)
	}
	refusedWith(t, f.finish("core.notices.clear", map[string]any{"group": "later"}), "group later is not today, yesterday or a day")
}

func TestClearAllKeepsProgressEntries(t *testing.T) {
	f, _ := centerShell(t, nil)
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "info", "title": "Done"}); err != nil {
		t.Fatal(err)
	}
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "progress", "title": "Running"}); err != nil {
		t.Fatal(err)
	}
	if err := f.finish("core.notices.clear-all", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	entries := noticesOf(t, f).Entries
	if len(entries) != 1 || entries[0].Kind != "progress" {
		t.Fatalf("the entries are %+v, want only the progress entry", entries)
	}
}

func TestEntriesAreWrittenToTheHostOnChange(t *testing.T) {
	f, stored := centerShell(t, nil)
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "error", "title": "Broken"}); err != nil {
		t.Fatal(err)
	}
	document, ok := stored.notices.(map[string]any)
	if !ok {
		t.Fatalf("the host holds %#v, want the notices document", stored.notices)
	}
	list, _ := document["notices"].([]any)
	if len(list) != 1 {
		t.Fatalf("the host holds %d notices, want 1", len(list))
	}
}

func TestEntriesAreReadFromTheHostAtStart(t *testing.T) {
	at := time.Now().Format(time.RFC3339)
	f, _ := centerShell(t, map[string]any{"format": 2, "notices": []any{map[string]any{
		"id": "notice-1", "kind": "error", "title": "Kept", "text": "", "source": map[string]any{"kind": "plugin", "plugin": "fieldprobe"},
		"actions": []any{}, "at": at, "count": 1, "read": false}}})
	if entry := entryTitled(t, f, "Kept"); entry.Kind != "error" || entry.Read {
		t.Fatalf("the entry is %+v, want the kept unread error", entry)
	}
}

func TestExpiredEntriesAreDroppedWhenTheHostIsRead(t *testing.T) {
	old := time.Now().Add(-8 * 24 * time.Hour).Format(time.RFC3339)
	f, _ := centerShell(t, map[string]any{"format": 2, "notices": []any{map[string]any{
		"id": "notice-1", "kind": "info", "title": "Stale", "text": "", "source": map[string]any{"kind": "core"},
		"actions": []any{}, "at": old, "count": 1, "read": true}}})
	if n := len(noticesOf(t, f).Entries); n != 0 {
		t.Fatalf("%d entries remain; the info entry of 8 days is expired", n)
	}
}

// centerShell starts a window whose host has the plugin fieldprobe loaded, which the commands name, and whose notices.json holds
// notices, a document of the current form or nil when the file does not exist.
func centerShell(t *testing.T, notices any) (*shellFixture, *surfaceHost) {
	t.Helper()
	stored := &surfaceHost{window: workbench.WindowView{Visible: true, Scale: 2, Width: 1200, Height: 800}}
	stored.notices = notices
	return surfaceShellOn(t, sidebarsInstalled, stored), stored
}

func TestACardNoticeNamesItsCardAndTab(t *testing.T) {
	f := sidebarShell(t)
	card := f.tabbedCards()[0]
	if err := f.finish("core.notices.add", map[string]any{"card": card, "kind": "info", "title": "Card"}); err != nil {
		t.Fatal(err)
	}
	entry := entryTitled(t, f, "Card")
	if entry.Source["kind"] != "card" || entry.Source["card"] != card || entry.Source["tab"] == "" {
		t.Fatalf("the source is %+v, want the card %s and its tab", entry.Source, card)
	}
}

func TestAddRefusesACardThatDoesNotExist(t *testing.T) {
	f := sidebarShell(t)
	refusedWith(t, f.finish("core.notices.add", map[string]any{"card": "c-none", "kind": "info", "title": "x"}), "card c-none does not exist")
}

// The add of a notice shows it as a toast of core.toasts, the same path as an error toast (docs/spec/notifications.md#commands-and-statuses).
func TestAnAddedNoticeShowsAsAToast(t *testing.T) {
	f, _ := centerShell(t, nil)
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "info", "title": "Toasted"}); err != nil {
		t.Fatal(err)
	}
	for _, toast := range f.toasts() {
		if toast.Title == "Toasted" && toast.Kind == "info" {
			return
		}
	}
	t.Fatalf("core.toasts holds %+v, want the added notice", f.toasts())
}

// Two adds with the same kind and title merge into one entry that counts both (docs/spec/notifications.md#notices).
func TestTwoEqualAddsMergeIntoOneEntryWithCountTwo(t *testing.T) {
	f, _ := centerShell(t, nil)
	for i := 0; i < 2; i++ {
		if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "info", "title": "Same"}); err != nil {
			t.Fatal(err)
		}
	}
	entries := noticesOf(t, f).Entries
	if len(entries) != 1 || entries[0].Count != 2 {
		t.Fatalf("the entries are %+v, want one entry with count 2", entries)
	}
}

// The toggle opens and closes the center, which the status core.notices reports (docs/spec/notifications.md#notice-center).
func TestToggleOpensAndClosesTheCenter(t *testing.T) {
	f, _ := centerShell(t, nil)
	if err := f.finish("core.notices.toggle", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if !noticesOf(t, f).Open {
		t.Fatal("the center is closed after core.notices.toggle")
	}
	if err := f.finish("core.notices.toggle", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if noticesOf(t, f).Open {
		t.Fatal("the center is open after the second core.notices.toggle")
	}
}

// The filter is all by default, and core.notices.filter sets it or refuses a value that is not a filter.
func TestFilterSetsTheFilterAndRefusesAnotherValue(t *testing.T) {
	f, _ := centerShell(t, nil)
	if got := noticesOf(t, f).Filter; got != "all" {
		t.Fatalf("the filter is %q, want all", got)
	}
	if err := f.finish("core.notices.filter", map[string]any{"filter": "problems"}); err != nil {
		t.Fatal(err)
	}
	if got := noticesOf(t, f).Filter; got != "problems" {
		t.Fatalf("the filter is %q, want problems", got)
	}
	// The declared schema of the filter is the enum of the three filters, so the registry refuses another value with -32602 before the handler.
	var refusal *workbench.Refusal
	if err := f.finish("core.notices.filter", map[string]any{"filter": "later"}); !errors.As(err, &refusal) || refusal.Code != workbench.InvalidParams {
		t.Fatalf("the filter command failed with %v, want the refusal -32602", err)
	}
}

// Opening the center drops the expired entries and writes notices.json without them.
func TestOpeningTheCenterDropsExpiredEntriesAndWritesTheFile(t *testing.T) {
	old := time.Now().Add(-8 * 24 * time.Hour).Format(time.RFC3339)
	stored := map[string]any{"format": 2, "notices": []any{map[string]any{
		"id": "notice-1", "kind": "info", "title": "Stale", "text": "", "source": map[string]any{"kind": "core"},
		"actions": []any{}, "at": old, "count": 1, "read": true}}}
	f, host := centerShell(t, stored)
	if err := f.finish("core.notices.toggle", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	document, _ := host.notices.(map[string]any)
	if list, _ := document["notices"].([]any); len(list) != 0 {
		t.Fatalf("notices.json holds %d entries after opening, want none", len(list))
	}
}

// The bell of the title bar opens and closes the center (docs/spec/notifications.md#bell).
func TestTheBellOpensAndClosesTheCenter(t *testing.T) {
	f, _ := centerShell(t, nil)
	f.click("core.chrome.notices", "")
	if !noticesOf(t, f).Open {
		t.Fatal("the center is closed after the press of the bell")
	}
	f.click("core.chrome.notices", "")
	if noticesOf(t, f).Open {
		t.Fatal("the center is open after the second press of the bell")
	}
}

// The tooltip of the bell names the unread notices (docs/spec/notifications.md#bell).
func TestTheBellTooltipNamesTheUnreadNotices(t *testing.T) {
	f, _ := centerShell(t, nil)
	if node, ok := keyed(f.elementTree(), "core.chrome.notices", ""); !ok || node.Label != "알림 센터" {
		t.Fatalf("the bell label is %q, want 알림 센터", node.Label)
	}
	if err := f.finish("core.notices.add", map[string]any{"plugin": "fieldprobe", "kind": "info", "title": "Unread"}); err != nil {
		t.Fatal(err)
	}
	if node, ok := keyed(f.elementTree(), "core.chrome.notices", ""); !ok || node.Label != "알림 센터, 읽지 않음 1개" {
		t.Fatalf("the bell label is %q, want the unread count", node.Label)
	}
}
