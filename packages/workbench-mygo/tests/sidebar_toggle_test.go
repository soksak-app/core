package workbench_test

import (
	"encoding/json"
	"testing"

	"github.com/egoist/mygo/ui"
)

// appliedSide returns the applied visibility value of a window side from the settings status.
func appliedSide(t *testing.T, f *shellFixture, side string) bool {
	t.Helper()
	on, ok := f.settingsStatus().Values[side].(bool)
	if !ok {
		t.Fatalf("the applied value of the %s side is not a bool", side)
	}
	return on
}

// Each window side has a shortcut that negates its visibility on the work screen: ⌘B the left side, ⌥⌘B the right side, ⇧⌘J the top
// side and ⌘J the bottom side (docs/spec/external-sidebars.md#window-tools).
func TestTheSideShortcutsToggleTheirSide(t *testing.T) {
	for _, c := range []struct {
		side string
		mods ui.Modifiers
		key  ui.Key
	}{
		{"left", ui.Cmd, ui.KeyB},
		{"right", ui.Alt | ui.Cmd, ui.KeyB},
		{"top", ui.Shift | ui.Cmd, ui.KeyJ},
		{"bottom", ui.Cmd, ui.KeyJ},
	} {
		f := sidebarShell(t)
		before := appliedSide(t, f, c.side)
		f.tester.Key(c.mods, c.key)
		f.settle()
		if got := appliedSide(t, f, c.side); got == before {
			t.Fatalf("the %s shortcut left the %s side at %v", c.side, c.side, got)
		}
		f.tester.Key(c.mods, c.key)
		f.settle()
		if got := appliedSide(t, f, c.side); got != before {
			t.Fatalf("the %s shortcut did not return the %s side to %v", c.side, c.side, before)
		}
	}
}

// The command core.sidebar.toggle negates the applied value of the side that its side parameter names, and the registry refuses a side that
// is not in the declared enum of the parameter.
func TestTheSideCommandNegatesItsSideAndRefusesAnUnknownSide(t *testing.T) {
	f := sidebarShell(t)
	before := appliedSide(t, f, "top")
	f.run("core.sidebar.toggle", map[string]any{"side": "top"})
	f.settle()
	if got := appliedSide(t, f, "top"); got == before {
		t.Fatalf("core.sidebar.toggle left the top side at %v", got)
	}
	if err := commandFailure(t, f, "core.sidebar.toggle", map[string]any{"side": "middle"}); err == nil || err.Error() != "invalid params for core.sidebar.toggle" {
		t.Fatalf("core.sidebar.toggle with an unknown side failed with %v", err)
	}
}

// commandFailure runs a command and returns its error, which run would fail the test with.
func commandFailure(t *testing.T, f *shellFixture, name string, params any) error {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	var failure error
	f.shell.Registry().RunLater(name, raw, func(_ any, err error) { failure = err })
	f.settle()
	return failure
}

// The side shortcuts run only on the work screen, as the rows of the shortcut table state: on the project home ⌘B changes no side.
func TestTheSideShortcutsDoNothingOnTheProjectHome(t *testing.T) {
	f := newShell(t, &storedHost{})
	before := f.settingsStatus().Values["left"]
	f.tester.Key(ui.Cmd, ui.KeyB)
	f.settle()
	if after := f.settingsStatus().Values["left"]; after != before {
		t.Fatalf("⌘B changed the left side from %v to %v on the project home", before, after)
	}
}
