package workbench_test

import (
	"testing"
)

// The head of the open center has the close control, the element core.notices.toggle, which runs core.notices.toggle
// (docs/spec/notifications.md#notice-center).
func TestTheOpenCenterHasItsCloseControl(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	if err := f.finish("core.notices.add", map[string]any{"card": f.tabbedCards()[0], "kind": "info", "title": "Shown"}); err != nil {
		t.Fatal(err)
	}
	f.click("core.chrome.notices", "")
	f.settle()
	if !f.has("core.notices.toggle", "") {
		t.Fatal("the open center has no close control core.notices.toggle")
	}
}
