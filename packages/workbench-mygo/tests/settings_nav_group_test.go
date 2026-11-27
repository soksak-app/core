package workbench_test

import (
	"encoding/json"
	"errors"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// A group of a page is named by its id in core.settings-tab.nav, and the page scrolls the group into view (docs/spec/settings.md#rows).
func TestTheSettingsNavScrollsTheNamedGroupIntoView(t *testing.T) {
	f := opened(t)
	f.tester.SetSize(1200, 500)
	f.run("core.settings-tab.nav", map[string]any{"page": "behavior", "group": "notices"})
	f.settle()

	rect, ok := f.tester.Find("알림은 세 곳에 나온다: 카드 상태줄(그 카드의 알림), 토스트(앱 알림), 알림 센터(전부).")
	if !ok {
		t.Fatalf("the group 알림 is not drawn on the behavior page; the texts are %q", f.tester.Texts())
	}
	if rect.Y < 0 || rect.Y >= 500 {
		t.Errorf("the group 알림 starts at y %v, outside the visible window of 500 points", rect.Y)
	}
}

// An unknown group of a page is refused with the code -32602 and the page does not change.
func TestTheSettingsNavRefusesAnUnknownGroup(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "behavior"})
	var failure error
	raw, err := json.Marshal(map[string]any{"page": "behavior", "group": "missing"})
	if err != nil {
		t.Fatal(err)
	}
	f.shell.Registry().RunLater("core.settings-tab.nav", raw, func(_ any, err error) { failure = err })
	f.pending.drain(f.t)
	var coded *workbench.Refusal
	if !errors.As(failure, &coded) || coded.Code != workbench.InvalidParams || coded.Message != `unknown group "missing" of page "behavior"` {
		t.Fatalf("error %#v, want -32602 naming the group and the page", failure)
	}
}

// The gear core.notices.settings of the notice center opens the settings tab at the group Notifications of the page Behavior (docs/spec/notifications.md#notice-center).
func TestTheNoticeCenterGearOpensTheNoticesGroup(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	if err := f.finish("core.notices.add", map[string]any{"card": f.tabbedCards()[0], "kind": "info", "title": "Shown"}); err != nil {
		t.Fatal(err)
	}
	f.click("core.chrome.notices", "")
	f.settle()
	f.click("core.notices.settings", "")
	f.tester.SetSize(1200, 500)
	f.settle()

	rect, ok := f.tester.Find("알림은 세 곳에 나온다: 카드 상태줄(그 카드의 알림), 토스트(앱 알림), 알림 센터(전부).")
	if !ok {
		t.Fatalf("the gear shows no group 알림; the texts are %q", f.tester.Texts())
	}
	if rect.Y < 0 || rect.Y >= 500 {
		t.Errorf("the group 알림 starts at y %v, outside the visible window of 500 points", rect.Y)
	}
}
