package workbench

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// The commands of the settings tab that change its state, and the toast of the last change (docs/spec/settings.md#saving-and-undo,
// #search and #status).

// settingsUndoDelay is the time the toast of a change stays on the tab (docs/spec/settings.md#saving-and-undo).
const settingsUndoDelay = 5 * time.Second

// registerSettingsTabCommands registers the commands of the settings tab that are not the commands of the page builders.
func (s *Shell) registerSettingsTabCommands() {
	w := &s.settingsTab
	search := func(value windowParam) error {
		if value.Query == nil {
			return errors.New("query must be a string")
		}
		w.query = *value.Query
		return nil
	}
	windowAct(s, "core.settings-tab.search", search)
	windowAct(s, "core.settings-tab.browse", func(value windowParam) error {
		if value.Query != nil {
			w.browse.query = *value.Query
			w.browse.limit = settingsBrowseFirst
		}
		if value.HideInstalled != nil {
			w.browse.hideInstalled = *value.HideInstalled
			w.browse.limit = settingsBrowseFirst
		}
		if value.More {
			w.browse.limit += settingsBrowseFirst
		}
		return nil
	})
	windowAct(s, "core.settings-tab.undo", func(windowParam) error {
		s.undoChange()
		return nil
	})
	windowAct(s, "core.settings-tab.confirm", func(value windowParam) error {
		if value.Kind == nil || value.ID == nil {
			return errors.New("kind and id must be strings")
		}
		switch value.Answer {
		case "ask":
			w.confirm = settingsConfirm{kind: *value.Kind, id: *value.ID}
		case "no":
			w.confirm = settingsConfirm{}
		case "yes":
			if w.confirm.kind != *value.Kind || w.confirm.id != *value.ID {
				return fmt.Errorf("no confirmation of %s %s is open", *value.Kind, *value.ID)
			}
			w.confirm = settingsConfirm{}
			return s.confirmed(*value.Kind, *value.ID)
		default:
			return fmt.Errorf("unknown answer %s", value.Answer)
		}
		return nil
	})
}

// confirmed runs the removal that a confirmation of kind confirmed: a set is deleted in the scope of its sets, and a plugin is removed.
func (s *Shell) confirmed(kind, id string) error {
	switch kind {
	case "set":
		// The run sends only the members that the command declares, so the schema accepts it.
		s.binder.run("core.settings.sets.delete", map[string]any{"id": id, "scope": inScope(s.settingsTab.scope)})
	case "plugin":
		s.binder.run("core.plugins.remove", pluginParam{Plugin: id})
	default:
		return fmt.Errorf("unknown confirmation kind %s", kind)
	}
	return nil
}

// recordChange shows the toast of a change that the tab made: the old and new value of key in scope. A change made outside the tab shows
// no toast. The toast lasts settingsUndoDelay and a new toast replaces the one shown.
func (s *Shell) recordChange(key, scope string, old, new any, wasOverridden bool) {
	w := &s.settingsTab
	if !w.open || key == "" || undoQuiet(key) {
		return
	}
	label := key
	if model := w.model; model != nil {
		if name, ok := model.labels[key]; ok {
			label = name
		}
	}
	toast := &settingsUndo{key: key, label: label, scope: scope, old: old, new: new, reset: scope == "project" && !wasOverridden}
	toast.text = s.undoText(key, label, old, new)
	s.showUndo(toast)
}

// recordTheme shows the toast of a theme change: Theme: <old> → <new>. Its undo restores the old theme and mode.
func (s *Shell) recordTheme(scope, oldName, oldMode, newName string) {
	w := &s.settingsTab
	if !w.open || oldName == newName {
		return
	}
	toast := &settingsUndo{key: "theme", label: "테마", scope: scope, old: oldName, new: newName, mode: oldMode}
	toast.text = fmt.Sprintf("테마: %s → %s", oldName, newName)
	s.showUndo(toast)
}

// undoQuiet tells whether a change shows no toast: the sets, the links, the diagnostics switches and the orders of the windows and cards
// (docs/spec/settings.md#saving-and-undo).
func undoQuiet(key string) bool {
	switch key {
	case "sets", "links", "diagnostics.log", "diagnostics.performance":
		return true
	}
	return strings.HasSuffix(key, ".win.order") || strings.HasSuffix(key, ".card.order")
}

// undoText is the text of the toast of a change: a side switch names its side, a sidebar order lists its sides, and any other change
// shows <label>: <old> → <new> with each value as a control shows it (docs/spec/settings.md#saving-and-undo).
func (s *Shell) undoText(key, label string, old, new any) string {
	if side, ok := sideNames[key]; ok {
		return fmt.Sprintf("%s 사이드바 보이기: %s → %s", side, s.undoValueText(key, old), s.undoValueText(key, new))
	}
	if key == "sidebarOrder" {
		names := []string{}
		if list, ok := new.([]any); ok {
			for _, item := range list {
				names = append(names, sideNames[fmt.Sprint(item)])
			}
		}
		return "배치 순서: " + strings.Join(names, " → ")
	}
	return fmt.Sprintf("%s: %s → %s", label, s.undoValueText(key, old), s.undoValueText(key, new))
}

// undoValueText is a value of a toast: a switch shows On or Off, a choice shows the label of its option, and any other value is its text.
func (s *Shell) undoValueText(key string, value any) string {
	if on, ok := value.(bool); ok {
		if on {
			return "켬"
		}
		return "끔"
	}
	if model := s.settingsTab.model; model != nil {
		for _, control := range model.controls {
			if control.Key != nil && *control.Key == key {
				if label, ok := control.labels[valueText(value)]; ok {
					return label
				}
			}
		}
	}
	return valueText(value)
}

// showUndo shows the toast, which replaces the one shown and lasts settingsUndoDelay.
func (s *Shell) showUndo(toast *settingsUndo) {
	w := &s.settingsTab
	if w.undo != nil && w.undo.cancel != nil {
		w.undo.cancel()
	}
	if s.tabs != nil {
		toast.cancel = s.tabs.after(settingsUndoDelay.Milliseconds(), func() {
			if w.undo == toast {
				w.undo = nil
				s.options.Invalidate()
			}
		})
	}
	w.undo = toast
}

// undoChange runs the change of the toast with its old value and removes the toast. Without a toast it changes nothing.
func (s *Shell) undoChange() {
	w := &s.settingsTab
	toast := w.undo
	if toast == nil {
		return
	}
	if toast.cancel != nil {
		toast.cancel()
	}
	w.undo = nil
	// The change goes through the store and the same path as its command, without a toast of its own.
	if toast.key == "theme" {
		name, err := typedSetting[string]("theme", toast.old)
		if err != nil {
			s.fail(err)
			return
		}
		if err := s.changing("core.settings.theme", func() error { return s.settings.Theme(name, toast.mode, toast.scope) }); err != nil {
			s.fail(err)
		}
		return
	}
	if toast.reset {
		if err := s.changing("core.settings.reset", func() error { return s.settings.Reset(toast.key) }); err != nil {
			s.fail(err)
		}
		return
	}
	if err := s.changing("core.settings.change", func() error { return s.settings.Change(toast.key, toast.old, toast.scope) }); err != nil {
		s.fail(err)
	}
}
