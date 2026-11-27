package workbench_test

import (
	"testing"
)

// The open center has the switch Quiet beside its filter, the element core.notices.quiet, which runs core.settings.set with the patch
// of quietToasts (docs/spec/notifications.md#notice-center).
func TestTheOpenCenterHasTheQuietSwitch(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	if err := f.finish("core.notices.add", map[string]any{"card": f.tabbedCards()[0], "kind": "info", "title": "Shown"}); err != nil {
		t.Fatal(err)
	}
	f.click("core.chrome.notices", "")
	f.settle()
	if !f.has("core.notices.quiet", "") || !f.tester.HasText("조용히") {
		t.Fatal("the open center has no switch 조용히 beside its filter")
	}
	f.click("core.notices.quiet", "")
	f.settle()
	values := status[map[string]any](t, f.shellFixture, "core.settings")["values"].(map[string]any)
	if on, _ := values["quietToasts"].(bool); !on {
		t.Fatal("pressing 조용히 did not turn quietToasts on")
	}
}
