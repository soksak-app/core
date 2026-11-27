package workbench_test

import (
	"strings"
	"testing"
)

// An error toast offers 자세히, which opens the notice center at the notice through core.notices.show
// (docs/spec/notifications.md#toasts).
func TestAnErrorToastOffersShowWhichOpensTheCenterAtIt(t *testing.T) {
	f := noticeShell(t, nil, "first failed")
	if !f.tester.HasText("자세히") {
		t.Fatalf("the error toast offers no 자세히: %q", f.tester.Texts())
	}
	f.click("core.notices.action", f.noticeFor("first failed"))
	f.settle()
	if !f.has("core.notices.panel", "") {
		t.Fatal("자세히 did not open the notice center")
	}
}

// core.notices.show refuses an id that no entry has with -32602 and the text that names the id
// (docs/spec/notifications.md#commands-and-statuses).
func TestTheShowCommandRefusesAnIdWithNoEntry(t *testing.T) {
	f := noticeShell(t, nil, "first failed")
	err := f.finish("core.notices.show", map[string]any{"id": "missing"})
	if err == nil || !strings.Contains(err.Error(), "no notice missing exists") {
		t.Fatalf("core.notices.show of a missing id answered %v", err)
	}
}
