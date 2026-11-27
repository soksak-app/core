package workbench_test

import (
	"testing"
)

// The open center draws its head, its filter with the counts, and its foot (docs/spec/notifications.md#notice-center).
func TestTheOpenCenterDrawsItsHeadFilterAndFoot(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	if err := f.finish("core.notices.add", map[string]any{"card": f.tabbedCards()[0], "kind": "info", "title": "Shown"}); err != nil {
		t.Fatal(err)
	}
	f.click("core.chrome.notices", "")
	f.settle()
	for _, text := range []string{"알림", "모두 읽음", "전체 1", "오류·경고 0", "진행 중 0", "오류는 지울 때까지, 나머지는 7일 동안 남는다.", "모두 지우기"} {
		if !f.tester.HasText(text) {
			t.Fatalf("the open center shows no %q; the texts are %q", text, f.tester.Texts())
		}
	}
	if !f.has("core.notices.panel", "") {
		t.Fatal("the open center has no element core.notices.panel")
	}
}

// Entries are grouped under 오늘, and a progress entry is first under 진행 중 (docs/spec/notifications.md#notice-center).
func TestTheCenterGroupsEntriesByDay(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	if err := f.finish("core.notices.add", map[string]any{"card": f.tabbedCards()[0], "kind": "progress", "title": "Working"}); err != nil {
		t.Fatal(err)
	}
	if err := f.finish("core.notices.add", map[string]any{"card": f.tabbedCards()[0], "kind": "info", "title": "Today entry"}); err != nil {
		t.Fatal(err)
	}
	f.click("core.chrome.notices", "")
	f.settle()
	for _, text := range []string{"진행 중", "오늘", "지우기", "Working", "Today entry"} {
		if !f.tester.HasText(text) {
			t.Fatalf("the open center shows no %q; the texts are %q", text, f.tester.Texts())
		}
	}
}

// A press on an entry reads it, and the clear button of a group removes its entries.
func TestAPressOnAnEntryReadsItAndTheGroupClearRemovesIt(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	if err := f.finish("core.notices.add", map[string]any{"card": f.tabbedCards()[0], "kind": "info", "title": "Pressed"}); err != nil {
		t.Fatal(err)
	}
	id := entryTitled(t, f.shellFixture, "Pressed").ID
	f.click("core.chrome.notices", "")
	f.settle()
	f.click("core.notices.entry", id)
	if !entryTitled(t, f.shellFixture, "Pressed").Read {
		t.Fatal("the entry is unread after its press")
	}
	f.click("core.notices.clear", "today")
	f.settle()
	if n := len(noticesOf(t, f.shellFixture).Entries); n != 0 {
		t.Fatalf("%d entries remain after the clear of today", n)
	}
}
