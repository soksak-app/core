package workbench_test

import (
	"testing"
)

// The project home has the button that opens the form of a repository import.
func TestTheHomeShowsTheImportButton(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.settle()
	if !f.has("core.home.import", "") {
		t.Fatal("the project home has no import button")
	}
}

// The import form shows the target under projectsFolder, named by the last element of the address without .git.
func TestTheImportFormShowsItsTargetUnderTheProjectsFolder(t *testing.T) {
	f := newShell(t, &storedHost{common: map[string]any{"projectsFolder": "~/Work"}})
	f.settle()
	f.run("core.home.form.open", map[string]string{"mode": "import"})
	f.run("core.home.form.set", map[string]string{"field": "address", "value": "https://example.com/acme/widget.git"})
	f.settle()
	if !f.tester.HasText("~/Work/widget") {
		t.Fatalf("the form does not show the target ~/Work/widget; texts %q", f.tester.Texts())
	}
}

// Submitting the form clones the repository into the target and opens the clone as a project.
func TestTheImportClonesIntoTheTargetAndOpensIt(t *testing.T) {
	f := newShell(t, &storedHost{common: map[string]any{"projectsFolder": "~/Work"}})
	f.settle()
	f.run("core.home.form.open", map[string]string{"mode": "import"})
	f.run("core.home.form.set", map[string]string{"field": "address", "value": "https://example.com/acme/widget.git"})
	f.run("core.home.form.submit", nil)
	f.settle()
	if len(f.host.clones) != 1 || f.host.clones[0]["address"] != "https://example.com/acme/widget.git" || f.host.clones[0]["target"] != "~/Work/widget" {
		t.Fatalf("projectClone calls %v, want one clone of the address into ~/Work/widget", f.host.clones)
	}
	for _, project := range f.host.projects {
		if project["root"] == "~/Work/widget" {
			return
		}
	}
	t.Fatalf("the clone was not added as a project; projects %v", f.host.projects)
}

// An empty address is refused before any clone starts, and the reason goes through the error display.
func TestAnEmptyImportAddressIsRefusedBeforeAClone(t *testing.T) {
	f := newShell(t, &storedHost{common: map[string]any{"projectsFolder": "~/Work"}})
	f.settle()
	f.run("core.home.form.open", map[string]string{"mode": "import"})
	submitRefused(f)
	if len(f.host.clones) != 0 {
		t.Fatalf("a clone started for an empty address: %v", f.host.clones)
	}
	if !f.tester.HasText("the address is empty") {
		t.Fatalf("the refusal is not shown; texts %q", f.tester.Texts())
	}
	if errors := f.host.written("workbench.record.error"); len(errors) != 1 {
		t.Fatalf("the shell recorded %v, want the refusal once", errors)
	}
}

// A refusal of the host adds no project and shows the text of the host.
func TestAHostRefusedCloneAddsNothingAndShowsTheHostText(t *testing.T) {
	f := newShell(t, &storedHost{common: map[string]any{"projectsFolder": "~/Work"}, cloneRefused: errString("~/Work/widget already exists")})
	f.settle()
	f.run("core.home.form.open", map[string]string{"mode": "import"})
	f.run("core.home.form.set", map[string]string{"field": "address", "value": "https://example.com/acme/widget.git"})
	submitRefused(f)
	for _, project := range f.host.projects {
		if project["root"] == "~/Work/widget" {
			t.Fatal("a refused clone was added as a project")
		}
	}
	if !f.tester.HasText("~/Work/widget already exists") {
		t.Fatalf("the host text is not shown; texts %q", f.tester.Texts())
	}
}

type errString string

func (e errString) Error() string { return string(e) }

// submitRefused submits the form and draws the frame that shows the refusal, which the shell records as an error of the home.
func submitRefused(f *shellFixture) {
	f.t.Helper()
	f.shell.Registry().RunLater("core.home.form.submit", []byte("null"), func(_ any, err error) {
		if err != nil {
			f.t.Errorf("the submit answered %v, want the refusal shown", err)
		}
	})
	f.pending.drain(f.t)
	f.tester.Frame()
	f.pending.drain(f.t)
	f.tester.Frame()
}
