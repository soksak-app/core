package workbench_test

import "testing"

// TestTheAddSectionSelectIsDisabledWhenTheSetHoldsEverySection checks that the select 섹션 추가… of an edited set takes no press
// once the set contains every registered section (docs/spec/settings.md#사이드바-세트).
func TestTheAddSectionSelectIsDisabledWhenTheSetHoldsEverySection(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "sets"})
	f.click("core.settings-tab.create", "")
	for {
		status := f.modal()
		var options []string
		for _, control := range status.Controls {
			if control.Name == "core.settings-tab.add" && control.Key != nil && *control.Key == "add:set-2" {
				options = control.Options
			}
		}
		if len(options) == 0 {
			break
		}
		f.run("core.settings.sets.row", map[string]any{"id": "set-2", "action": "add", "section": options[0]})
	}
	for _, control := range f.modal().Controls {
		if control.Name == "core.settings-tab.add" && control.Key != nil && *control.Key == "add:set-2" {
			if !control.Disabled {
				t.Fatal("the select 섹션 추가… takes a press although the set holds every section")
			}
			return
		}
	}
	t.Fatal("the select 섹션 추가… of the edited set is not drawn")
}
