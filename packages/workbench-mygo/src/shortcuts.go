package workbench

import (
	"fmt"
	"strings"

	"github.com/egoist/mygo/ui"
)

// The shortcut table of the workbench (shortcuts.json, docs/spec/exposure.md). A row of the owner workbench is a key that the
// workbench binds while the condition of the row holds; a native menu row belongs to the menu of the host, and a view handles its
// keys itself.

const (
	shortcutOwnerWorkbench = "workbench"
	shortcutOwnerView      = "view"
)

var shortcutModifiers = map[string]ui.Modifiers{"cmd": ui.Cmd, "shift": ui.Shift, "opt": ui.Alt, "ctrl": ui.Ctrl}

var shortcutKeys = map[string]ui.Key{",": ui.KeyComma, "Enter": ui.KeyEnter, "Escape": ui.KeyEscape, "=": ui.KeyEqual, "-": ui.KeyMinus}

// ParseShortcut reads a key of the shortcut table, as "shift+cmd+n".
func ParseShortcut(text string) (ui.Modifiers, ui.Key, error) {
	parts := strings.Split(text, "+")
	var mods ui.Modifiers
	for _, part := range parts[:len(parts)-1] {
		modifier, ok := shortcutModifiers[part]
		if !ok {
			return 0, 0, fmt.Errorf("shortcut %s has the unknown modifier %s", text, part)
		}
		mods |= modifier
	}
	name := parts[len(parts)-1]
	if key, ok := shortcutKeys[name]; ok {
		return mods, key, nil
	}
	if len(name) == 1 && name[0] >= 'a' && name[0] <= 'z' {
		return mods, ui.KeyA + ui.Key(name[0]-'a'), nil
	}
	if len(name) == 1 && name[0] >= '0' && name[0] <= '9' {
		return mods, ui.Key0 + ui.Key(name[0]-'0'), nil
	}
	return 0, 0, fmt.Errorf("shortcut %s has the unknown key %s", text, name)
}

// boundShortcut is a row of the workbench with its key and its condition.
type boundShortcut struct {
	mods    ui.Modifiers
	key     ui.Key
	command string
	holds   func() bool
}

// Shortcuts are the keys of the workbench.
type Shortcuts struct {
	rows   []boundShortcut
	run    func(command string) error
	failed func(command string, err error)
}

// NewShortcuts reads table. conditions holds the condition of each workbench row by the text of its when, run runs a command, and
// failed receives each command that fails. A key that cannot be read and a workbench row without a condition are errors.
func NewShortcuts(table []Shortcut, conditions map[string]func() bool, run func(command string) error, failed func(command string, err error)) (*Shortcuts, error) {
	shortcuts := &Shortcuts{run: run, failed: failed}
	for _, row := range table {
		if row.Owner == shortcutOwnerView {
			continue
		}
		mods, key, err := ParseShortcut(row.Key)
		if err != nil {
			return nil, err
		}
		if row.Owner != shortcutOwnerWorkbench {
			continue
		}
		holds := conditions[row.When]
		if holds == nil {
			return nil, fmt.Errorf("shortcut %s has no condition %q", row.Key, row.When)
		}
		shortcuts.rows = append(shortcuts.rows, boundShortcut{mods, key, row.Command, holds})
	}
	return shortcuts, nil
}

// Declare binds the keys of the rows whose condition holds in this frame. The view of the workbench calls it in each frame, and
// the first row of a key that holds takes the key.
func (s *Shortcuts) Declare(c *ui.Context) {
	type chord struct {
		mods ui.Modifiers
		key  ui.Key
	}
	bound := map[chord]bool{}
	for _, row := range s.rows {
		if at := (chord{row.mods, row.key}); !bound[at] && row.holds() {
			bound[at] = true
			c.OnShortcut(row.mods, row.key, func() {
				if err := s.run(row.command); err != nil {
					s.failed(row.command, err)
				}
			})
		}
	}
}
