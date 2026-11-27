package workbench_test

import "testing"

// TestTheDiagnosticsPageHeadShowsTheCommonOnlyBadgeInPlaceOfTheScope pins the page head of 진단: a page that has settings and none
// that a project can override shows the badge 전역 전용 and no scope control (docs/spec/settings.md#page-head).
func TestTheDiagnosticsPageHeadShowsTheCommonOnlyBadgeInPlaceOfTheScope(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "diag"})
	badges, scopes := 0, 0
	for _, control := range f.modal().Controls {
		switch control.Name {
		case "core.settings-tab.badge":
			if control.Label == "전역 전용" {
				badges++
			}
		case "core.settings-tab.scope":
			scopes++
		}
	}
	if badges != 1 || scopes != 0 {
		t.Errorf("the diagnostics page head has %d badges 전역 전용 and %d scope controls; want 1 and 0", badges, scopes)
	}
}
