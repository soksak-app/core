package workbench_test

import (
	"testing"
)

// The base folder of new projects is a common setting whose default is ~/Projects.
func TestTheProjectsFolderDefaultsToTheProjectsFolderOfTheHome(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	if got := store.Value("projectsFolder"); got != "~/Projects" {
		t.Fatalf("default projectsFolder = %v, want ~/Projects", got)
	}
}

// A value of projectsFolder is an absolute path or a path that starts with ~/; any other value is refused and changes nothing.
func TestAProjectsFolderThatIsNoAbsolutePathIsRefused(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"", "Projects", "projects/work", "~", "~user/work"} {
		err := store.Set(map[string]any{"projectsFolder": value}, "common")
		want := `Invalid setting projectsFolder: "` + value + `" is not an absolute path or a path that starts with ~/`
		if err == nil || err.Error() != want {
			t.Fatalf("Set(%q) = %v, want %s", value, err, want)
		}
	}
	if err := store.Set(map[string]any{"projectsFolder": 3.0}, "common"); err == nil {
		t.Fatal("a number was accepted as projectsFolder")
	}
	if got := store.Value("projectsFolder"); got != "~/Projects" {
		t.Fatalf("a refused change set projectsFolder to %v", got)
	}
	if len(writes) != 0 {
		t.Fatalf("a refused change was written %d times", len(writes))
	}
}

// An absolute path and a path that starts with ~/ are accepted in the common scope, and the project scope refuses the key.
func TestAProjectsFolderIsCommonOnly(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(nil, nil, "prj-a"); err != nil {
		t.Fatal(err)
	}
	if err := store.Set(map[string]any{"projectsFolder": "/work/base"}, "common"); err != nil {
		t.Fatal(err)
	}
	if err := store.Set(map[string]any{"projectsFolder": "~/Work"}, "common"); err != nil {
		t.Fatal(err)
	}
	if got := store.Value("projectsFolder"); got != "~/Work" {
		t.Fatalf("projectsFolder = %v, want ~/Work", got)
	}
	if err := store.Set(map[string]any{"projectsFolder": "~/Work"}, "project"); err == nil || err.Error() != "projectsFolder is common-only" {
		t.Fatalf("project scope: %v", err)
	}
}

// The parent folder of a new project starts with projectsFolder, so a new project created without a change is made in it.
func TestTheCreateFormStartsInTheProjectsFolder(t *testing.T) {
	f := newShell(t, &storedHost{common: map[string]any{"projectsFolder": "~/Work"}})
	f.settle()
	f.run("core.home.form.open", map[string]string{"mode": "create"})
	f.run("core.home.form.set", map[string]string{"field": "name", "value": "alpha"})
	f.run("core.home.form.submit", nil)
	f.settle()
	for _, project := range f.host.projects {
		if project["root"] == "~/Work/alpha" {
			return
		}
	}
	t.Fatalf("the project was not created in projectsFolder; projects %v", f.host.projects)
}

// The Workspace page draws the folder row of projectsFolder with the path and the button that chooses another folder.
func TestTheWorkspacePageDrawsTheProjectsFolderRow(t *testing.T) {
	f := newShell(t, &storedHost{common: map[string]any{"projectsFolder": "~/Work"}})
	f.settle()
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]any{"page": "workspace"})
	f.settle()
	var found bool
	for _, control := range f.modal().Controls {
		if control.Name != "core.settings-tab.choose-folder" {
			continue
		}
		found = true
		if control.Command == nil || control.Command.Name != "core.settings.choose-folder" || control.Command.Params["key"] != "projectsFolder" {
			t.Fatalf("the folder button has command %+v, want core.settings.choose-folder for projectsFolder", control.Command)
		}
	}
	if !found {
		t.Fatal("the workspace page has no folder button")
	}
	if !f.tester.HasText("~/Work") {
		t.Fatalf("the folder row does not show the path; texts %q", f.tester.Texts())
	}
}

// The folder button sets projectsFolder to the folder that the dialog gives; a cancelled dialog changes nothing.
func TestTheFolderButtonSetsTheChosenFolder(t *testing.T) {
	f := newShell(t, &storedHost{common: map[string]any{"projectsFolder": "~/Work"}})
	f.settle()
	f.run("core.settings.choose-folder", map[string]any{"key": "projectsFolder", "scope": "common"})
	f.settle()
	if got := f.settingsStatus().Values["projectsFolder"]; got != "/chosen" {
		t.Fatalf("projectsFolder = %v, want the chosen folder /chosen", got)
	}
}
