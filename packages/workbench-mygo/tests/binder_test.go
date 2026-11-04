// The registry and the binder hold each interactive element of the workbench to a declared command and an element name
// (docs/spec/hosts.md#workbench).
package workbench_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

func registry(t *testing.T) *workbench.Registry {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	return workbench.NewRegistry(declared)
}

// refused fails the test when register does not panic.
func refused(t *testing.T, register func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Error("the registration was accepted")
		}
	}()
	register()
}

func TestTheRegistryRefusesAnUndeclaredName(t *testing.T) {
	r := registry(t)
	refused(t, func() { r.Command("core.absent", func(json.RawMessage) (any, error) { return nil, nil }) })
	refused(t, func() { r.Status("core.absent", func() any { return nil }) })
}

func TestTheRegistryRefusesASecondRegistration(t *testing.T) {
	r := registry(t)
	r.Command("core.space.add", func(json.RawMessage) (any, error) { return nil, nil })
	refused(t, func() { r.Command("core.space.add", func(json.RawMessage) (any, error) { return nil, nil }) })
}

func TestTheRegistryRunsACommandAndReadsAStatus(t *testing.T) {
	r := registry(t)
	r.Command("core.space.add", func(params json.RawMessage) (any, error) { return string(params), nil })
	r.Status("core.layout", func() any { return "the layout" })
	result, err := r.Run("core.space.add", json.RawMessage(`{"a":1}`))
	if err != nil || result != `{"a":1}` {
		t.Fatalf("the command gave %v, %v", result, err)
	}
	if value, err := r.Read("core.layout"); err != nil || value != "the layout" {
		t.Fatalf("the status gave %v, %v", value, err)
	}
	if _, err := r.Run("core.space.close", nil); err == nil || !strings.Contains(err.Error(), "core.space.close") {
		t.Fatalf("a command that is not registered gave %v", err)
	}
	if _, err := r.Read("core.grid"); err == nil || !strings.Contains(err.Error(), "core.grid") {
		t.Fatalf("a status that is not registered gave %v", err)
	}
}

func TestTheBinderRefusesAnUndeclaredNameWhenTheViewBuilds(t *testing.T) {
	binder := workbench.NewBinder(registry(t), nil)
	refused(t, func() {
		ui.NewTester(func(c *ui.Context) {
			binder.Press(c, "core.absent", "core.space.add", "", nil).Children(func() { ui.Text(c, "Add") })
		}, 200, 100)
	})
	refused(t, func() {
		ui.NewTester(func(c *ui.Context) {
			binder.Press(c, "core.chrome.left", "core.absent", "", nil).Children(func() { ui.Text(c, "Add") })
		}, 200, 100)
	})
}

func TestAPressRunsTheCommandOfTheElementWithItsParams(t *testing.T) {
	r := registry(t)
	var received string
	r.Command("core.space.add", func(params json.RawMessage) (any, error) {
		received = string(params)
		return nil, nil
	})
	binder := workbench.NewBinder(r, nil)
	tester := ui.NewTester(func(c *ui.Context) {
		binder.Press(c, "core.chrome.left", "core.space.add", "", map[string]any{"side": "left"}).Children(func() { ui.Text(c, "Add") })
	}, 200, 100)
	if err := tester.Click("Add"); err != nil {
		t.Fatal(err)
	}
	if received != `{"side":"left"}` {
		t.Fatalf("the command received %q", received)
	}
}

func TestAFailedPressGoesToTheFailureOfTheBinder(t *testing.T) {
	r := registry(t)
	var failed []string
	binder := workbench.NewBinder(r, func(command string, err error) { failed = append(failed, command+": "+err.Error()) })
	tester := ui.NewTester(func(c *ui.Context) {
		binder.Press(c, "core.chrome.left", "core.space.add", "", nil).Children(func() { ui.Text(c, "Add") })
	}, 200, 100)
	if err := tester.Click("Add"); err != nil {
		t.Fatal(err)
	}
	if len(failed) != 1 || !strings.HasPrefix(failed[0], "core.space.add: ") {
		t.Fatalf("the failures are %q", failed)
	}
}

func TestTheAuditListsEachInteractiveElementWithoutACommandOrAName(t *testing.T) {
	binder := workbench.NewBinder(registry(t), nil)
	tester := ui.NewTester(func(c *ui.Context) {
		ui.Column(c).Children(func() {
			binder.Press(c, "core.chrome.left", "core.space.add", "", nil).Children(func() { ui.Text(c, "Bound") })
			ui.Button(c, "Loose")
			ui.Text(c, "Plain text")
		})
	}, 200, 200)
	got := workbench.Audit(tester.ElementTree())
	want := []workbench.Unbound{{Role: "button", Expose: "", Command: "", Text: "Loose"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("the audit is %+v", got)
	}
}

func TestTheRolesOfTheElementTreeHaveAnAriaName(t *testing.T) {
	for role := ui.RoleGroup; role <= ui.RoleNavigation; role++ {
		if workbench.AriaRole(role) == "" {
			t.Errorf("role %d has no name", role)
		}
	}
	for role, name := range map[ui.Role]string{ui.RoleButton: "button", ui.RoleTextField: "textbox", ui.RoleTab: "tab", ui.RoleTreeItem: "treeitem"} {
		if got := workbench.AriaRole(role); got != name {
			t.Errorf("role %d is %q, want %q", role, got, name)
		}
	}
}
