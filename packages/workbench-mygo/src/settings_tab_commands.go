package workbench

import (
	"errors"
	"fmt"
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
func (s *Shell) recordChange(key, scope string, old, new any) {
	w := &s.settingsTab
	if !w.open || key == "" {
		return
	}
	if w.undo != nil && w.undo.cancel != nil {
		w.undo.cancel()
	}
	label := key
	if model := w.model; model != nil {
		if name, ok := model.labels[key]; ok {
			label = name
		}
	}
	toast := &settingsUndo{key: key, label: label, scope: scope, old: old, new: new}
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
	// The change goes through the store and the same path as core.settings.change, without a toast of its own.
	if err := s.changing("core.settings.change", func() error { return s.settings.Change(toast.key, toast.old, toast.scope) }); err != nil {
		s.fail(err)
	}
}
