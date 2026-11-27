package workbench_test

import "testing"

// The status line of the project home shows the number of projects, the number of open projects and the enabled and installed plugins
// (docs/spec/external-sidebars.md#status-bar).
func TestTheHomeStatusLineShowsTheProjectCounts(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	f.settle()
	if !f.tester.HasText("프로젝트 2") {
		t.Fatalf("the home status line shows %q, without the count of two projects", f.tester.Texts())
	}
	if !f.tester.HasText("열림 2") {
		t.Fatalf("the home status line shows %q, without the count of the two open projects", f.tester.Texts())
	}
}

// The button back to the work screen is shown only while the window has a work screen to return to, and it restores that screen.
func TestTheHomeBackButtonRestoresTheWorkScreen(t *testing.T) {
	f := openedShell(t)
	f.run("core.projects.browse", nil)
	f.settle()
	if !f.has("core.home.status.back", "") {
		t.Fatal("the home has no button back to the work screen while the window has one")
	}
	f.click("core.home.status.back", "")
	f.settle()
	if f.has("core.home.status.back", "") {
		t.Fatal("the button back is still shown after the work screen was restored")
	}
	if f.has("core.home.open", "") {
		t.Fatal("the project home is still shown after the button back")
	}
}

// Without a work screen the button back is absent, and the command core.home.back fails with the text of the web host.
func TestTheHomeBackFailsWithoutAWorkScreen(t *testing.T) {
	f := newShell(t, &storedHost{})
	if f.has("core.home.status.back", "") {
		t.Fatal("the button back is shown without a work screen to return to")
	}
	if err := commandFailure(t, f, "core.home.back", nil); err == nil || err.Error() != "there is no work screen to return to" {
		t.Fatalf("core.home.back failed with %v", err)
	}
}
