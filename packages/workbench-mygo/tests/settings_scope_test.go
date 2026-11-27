package workbench_test

import (
	"slices"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// settingsStatus is the value of core.settings.
func (f *shellFixture) settingsStatus() workbench.SettingsStatus {
	f.t.Helper()
	value, err := f.shell.Registry().Read("core.settings")
	if err != nil {
		f.t.Fatal(err)
	}
	return value.(workbench.SettingsStatus)
}

// modalControl is the control of the settings window with the element name and the key.
func (f *shellFixture) modalControl(name, key string) (on *bool, scope any, found bool) {
	f.t.Helper()
	for _, control := range f.modal().Controls {
		if control.Name == name && control.Key != nil && *control.Key == key {
			if control.Command != nil {
				scope = control.Command.Params["scope"]
			}
			return control.On, scope, true
		}
	}
	return nil, nil, false
}

// Every control of a setting shows the applied value and the scope that the value comes from, and writes to that scope; only the
// project tab adds or removes a project value (docs/spec/settings.md#scope-of-a-control).
func TestAControlChangesTheValueThatItShowsInTheScopeThatTheValueComesFrom(t *testing.T) {
	f := openedShell(t)
	// The project overrides no side, so the chrome switch of the left side changes the common value.
	f.click("core.chrome.left", "")
	status := f.settingsStatus()
	if slices.Contains(status.Overridden, "left") || status.Common["left"] != false || status.Values["left"] != false {
		t.Fatalf("the left switch wrote %+v common %v applied %v", status.Overridden, status.Common["left"], status.Values["left"])
	}
	// The fold control of the right sidebar changes the common value as well.
	// The fold shows while the pointer is over its sidebar, as it does on the page.
	right := f.box("core.card", "right")
	f.tester.Move(right.X+right.W/2, right.Y+right.H/2)
	f.settle()
	f.click("core.sidebar.fold", "right")
	status = f.settingsStatus()
	if slices.Contains(status.Overridden, "right") || status.Common["right"] != false {
		t.Fatalf("the fold control wrote %+v common %v", status.Overridden, status.Common["right"])
	}
	// The project overrides the top side and the mode, so their chrome switches change the project values.
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"top": true, "mode": "light"}, "scope": "project"})
	f.click("core.chrome.top", "")
	f.run("core.settings.change", map[string]any{"key": "mode", "value": "dark", "scope": "project"})
	status = f.settingsStatus()
	if status.Values["top"] != false || status.Common["top"] != false || !slices.Contains(status.Overridden, "top") {
		t.Fatalf("the top switch: applied %v common %v overridden %v", status.Values["top"], status.Common["top"], status.Overridden)
	}
	if status.Values["mode"] != "dark" || status.Common["mode"] != "dark" || !slices.Contains(status.Overridden, "mode") {
		t.Fatalf("the mode switch: applied %v common %v overridden %v", status.Values["mode"], status.Common["mode"], status.Overridden)
	}
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"top": true}, "scope": "project"})
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"top": false}, "scope": "common"})

	f.tester.SetSize(1200, 3200)
	f.settle()
	f.click("core.chrome.settings", "")
	// The sides are on the page 작업 공간 and the mode on the page 모양 (docs/spec/settings.md#작업-공간).
	f.run("core.settings-tab.nav", map[string]any{"page": "workspace"})
	// The common tab shows the project value of the top side with its mark, and a press writes the project scope.
	on, scope, found := f.modalControl("core.settings-tab.side", "top")
	if !found || on == nil || !*on || scope != "project" {
		t.Fatalf("the top switch of the common tab: found %v on %v scope %v", found, on, scope)
	}
	if !f.has("core.settings-tab.applied", "applied:top") || !f.tester.HasText("프로젝트 값") {
		t.Fatalf("the common tab marks no project value of top; the texts are %q", f.tester.Texts())
	}
	// A setting without a project value shows the common value and writes the common scope, without a mark.
	on, scope, found = f.modalControl("core.settings-tab.side", "left")
	if !found || on == nil || *on || scope != "common" {
		t.Fatalf("the left switch of the common tab: found %v on %v scope %v", found, on, scope)
	}
	if _, _, marked := f.modalControl("core.settings-tab.applied", "applied:left"); marked {
		t.Fatal("the common tab marks a common value")
	}
	f.run("core.settings-tab.nav", map[string]any{"page": "look"})
	if _, scope, _ := f.modalControl("core.settings-tab.choice", "mode"); scope != "project" {
		t.Fatalf("the mode of the common tab writes %v", scope)
	}
	f.run("core.settings-tab.nav", map[string]any{"page": "workspace"})
	f.click("core.settings-tab.side", "top")
	status = f.settingsStatus()
	if status.Values["top"] != false || status.Common["top"] != false || !slices.Contains(status.Overridden, "top") {
		t.Fatalf("the top switch of the common tab: applied %v common %v overridden %v", status.Values["top"], status.Common["top"], status.Overridden)
	}
	if on, _, _ := f.modalControl("core.settings-tab.side", "top"); on == nil || *on {
		t.Fatalf("the top switch of the common tab shows %v after its press", on)
	}
	// The project tab marks nothing and keeps the button that removes the project value.
	f.run("core.settings-tab.scope", map[string]any{"scope": "project"})
	f.run("core.settings-tab.nav", map[string]any{"page": "workspace"})
	if _, _, marked := f.modalControl("core.settings-tab.applied", "applied:top"); marked {
		t.Fatal("the project tab marks its own value")
	}
	if !slices.Contains(f.modal().keys("core.settings-tab.reset"), "reset:top") {
		t.Fatal("the project tab has no reset of top")
	}
}
