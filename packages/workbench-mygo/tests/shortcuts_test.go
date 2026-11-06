package workbench_test

import (
	"errors"
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// everyCondition holds each condition of the workbench rows of the real table, none of them true.
func everyCondition(t *testing.T) map[string]func() bool {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	conditions := map[string]func() bool{}
	for _, row := range declared.Shortcuts {
		if row.Owner == "workbench" {
			conditions[row.When] = func() bool { return false }
		}
	}
	return conditions
}

// Each row of the declared table that names a key has one that the workbench can bind.
func TestEveryDeclaredShortcutHasAKey(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	if len(declared.Shortcuts) == 0 {
		t.Fatal("the shortcut table is empty")
	}
	if _, err := workbench.NewShortcuts(declared.Shortcuts, everyCondition(t), func(string) error { return nil }, func(string, error) {}); err != nil {
		t.Fatal(err)
	}
}

func TestParseShortcut(t *testing.T) {
	for _, c := range []struct {
		key  string
		mods ui.Modifiers
		want ui.Key
	}{
		{"cmd+k", ui.Cmd, ui.KeyK},
		{"shift+cmd+n", ui.Shift | ui.Cmd, ui.KeyN},
		{"opt+cmd+h", ui.Alt | ui.Cmd, ui.KeyH},
		{"cmd+0", ui.Cmd, ui.Key0},
		{"cmd+=", ui.Cmd, ui.KeyEqual},
		{"cmd+-", ui.Cmd, ui.KeyMinus},
		{"Enter", 0, ui.KeyEnter},
		{"Escape", 0, ui.KeyEscape},
	} {
		mods, key, err := workbench.ParseShortcut(c.key)
		if err != nil || mods != c.mods || key != c.want {
			t.Fatalf("ParseShortcut(%s) = %v, %v, %v", c.key, mods, key, err)
		}
	}
	for _, c := range []struct{ key, want string }{
		{"hyper+k", `shortcut hyper+k has the unknown modifier hyper`},
		{"cmd+space bar", `shortcut cmd+space bar has the unknown key space bar`},
	} {
		if _, _, err := workbench.ParseShortcut(c.key); err == nil || err.Error() != c.want {
			t.Fatalf("ParseShortcut(%s) failed with %v, want %s", c.key, err, c.want)
		}
	}
}

// A workbench row runs its command while its condition holds, and two rows of one key run the one whose condition holds. A
// row of another owner is no binding of the workbench.
func TestShortcutsRunTheCommandOfTheRowThatHolds(t *testing.T) {
	table := []workbench.Shortcut{
		{Key: "cmd+k", Owner: "workbench", Command: "core.library.search.focus", When: "The library is shown"},
		{Key: "Escape", Owner: "workbench", Command: "core.rename.cancel", When: "The tab rename field has focus"},
		{Key: "Escape", Owner: "workbench", Command: "core.picker.close", When: "A picker layer is open"},
		{Key: "cmd+=", Owner: "native menu", Command: "core.text.larger", When: "Any focus"},
		{Key: "text input keys", Owner: "view", Command: "none", When: "A plugin view has a text input focused"},
	}
	library, rename, picker := false, false, false
	conditions := map[string]func() bool{
		"The library is shown":           func() bool { return library },
		"The tab rename field has focus": func() bool { return rename },
		"A picker layer is open":         func() bool { return picker },
	}
	var ran []string
	shortcuts, err := workbench.NewShortcuts(table, conditions, func(command string) error {
		ran = append(ran, command)
		return nil
	}, func(string, error) {})
	if err != nil {
		t.Fatal(err)
	}
	tester := ui.NewTester(func(c *ui.Context) {
		shortcuts.Declare(c)
		ui.Text(c, "workbench")
	}, 200, 100)
	tester.Frame()

	tester.Key(ui.Cmd, ui.KeyK)
	tester.Key(0, ui.KeyEscape)
	tester.Key(ui.Cmd, ui.KeyEqual)
	if len(ran) != 0 {
		t.Fatalf("keys without a condition ran %v", ran)
	}
	library, picker = true, true
	tester.Frame()
	tester.Key(ui.Cmd, ui.KeyK)
	tester.Key(0, ui.KeyEscape)
	picker, rename = false, true
	tester.Frame()
	tester.Key(0, ui.KeyEscape)
	if want := []string{"core.library.search.focus", "core.picker.close", "core.rename.cancel"}; !slices.Equal(ran, want) {
		t.Fatalf("the keys ran %v, want %v", ran, want)
	}
}

// A workbench row without a condition, whose key would never run, is an error of the table.
func TestShortcutsRefuseARowWithoutACondition(t *testing.T) {
	table := []workbench.Shortcut{{Key: "cmd+k", Owner: "workbench", Command: "core.library.search.focus", When: "The library is shown"}}
	_, err := workbench.NewShortcuts(table, nil, func(string) error { return nil }, func(string, error) {})
	if err == nil || err.Error() != `shortcut cmd+k has no condition "The library is shown"` {
		t.Fatalf("the table failed with %v", err)
	}
}

// A command that fails reaches failed with its name.
func TestShortcutFailureReachesItsHandler(t *testing.T) {
	table := []workbench.Shortcut{{Key: "cmd+k", Owner: "workbench", Command: "core.library.search.focus", When: "Always"}}
	var failure string
	shortcuts, err := workbench.NewShortcuts(table, map[string]func() bool{"Always": func() bool { return true }},
		func(string) error { return errors.New("the library is hidden") },
		func(command string, err error) { failure = command + ": " + err.Error() })
	if err != nil {
		t.Fatal(err)
	}
	tester := ui.NewTester(shortcuts.Declare, 100, 100)
	tester.Frame()
	tester.Key(ui.Cmd, ui.KeyK)
	if want := "core.library.search.focus: the library is hidden"; failure != want {
		t.Fatalf("the failure is %q, want %q", failure, want)
	}
}

// ownKeyPlaces are the conditions of the workbench rows whose place takes its key with its own handler.
var ownKeyPlaces = []string{"The tab rename field has focus", "A picker layer is open", "A native modal menu is open and has keyboard focus"}

// projectWithoutOwnKeyRows opens a project with plugins in a shell whose shortcut table has no row of those places.
func projectWithoutOwnKeyRows(t *testing.T) *shellFixture {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	table := *declared
	table.Shortcuts = slices.DeleteFunc(slices.Clone(declared.Shortcuts), func(row workbench.Shortcut) bool {
		return slices.Contains(ownKeyPlaces, row.When)
	})
	// Enter and Escape of the rename field, Escape of the picker layer and Escape of a native modal menu.
	if removed := len(declared.Shortcuts) - len(table.Shortcuts); removed != 4 {
		t.Fatalf("the table holds %d rows of the places, not 4", removed)
	}
	f := startedShellOf(t, acme(), &table)
	f.settle()
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	return f
}

// The rename field takes Enter and Escape with its own handlers, as the field of the page does, so the keys save and leave a
// rename without a row of the table.
func TestTheRenameFieldTakesItsKeysItself(t *testing.T) {
	f := projectWithoutOwnKeyRows(t)
	id := f.host.projects[0]["id"].(string)
	doubleClick(f, f.box("core.project-tab", id))
	f.tester.Type("beta")
	f.tester.Frame()
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if got := status[*renameRead](t, f, "core.rename"); got != nil || storedTitle(f) != "beta" {
		t.Fatalf("after Enter the rename is %+v and the title %q", got, storedTitle(f))
	}
	doubleClick(f, f.box("core.project-tab", id))
	f.tester.Type("gamma")
	f.tester.Frame()
	f.tester.Key(0, ui.KeyEscape)
	f.settle()
	if got := status[*renameRead](t, f, "core.rename"); got != nil || storedTitle(f) != "beta" {
		t.Fatalf("after Escape the rename is %+v and the title %q", got, storedTitle(f))
	}
}

// The popover of the picker layer takes Escape and closes the layer, as the layer of the page does, so the key closes it without
// a row of the table.
func TestThePickerLayerTakesEscapeItself(t *testing.T) {
	f := projectWithoutOwnKeyRows(t)
	f.click("core.card.add", f.tabbedCards()[0])
	if !f.menu().Open {
		t.Fatal("the press did not open the menu")
	}
	f.tester.Key(0, ui.KeyEscape)
	f.settle()
	if f.menu().Open {
		t.Fatal("Escape leaves the menu open")
	}
}
