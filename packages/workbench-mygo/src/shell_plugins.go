package workbench

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/egoist/mygo/ui"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The plugin screen in a window: the commands and statuses of the plugin operations and the events of the host that change them.

type pluginParam struct {
	Plugin string `json:"plugin"`
	// End is nil when the params have no end, and a button that binds the params writes none.
	End *bool `json:"end,omitempty"`
}

// showSettingsPage opens the settings tab on page, and on the filter of 설치됨 when filter is not empty, as core.settings.open opens it
// (docs/spec/settings.md#plugins). The page scrolls to its top, as the page of a command does.
func (s *Shell) showSettingsPage(page, filter string) error {
	if err := s.dialogRefusal(); err != nil {
		return err
	}
	s.closeDebug()
	s.closePicker()
	w := &s.settingsTab
	w.open = true
	w.page, w.chosen, w.scroll = page, "", ui.ScrollState{}
	if filter != "" {
		w.filter = filter
	}
	s.options.Invalidate()
	return nil
}

// startPlugins reads the plugin state of a window that started and runs the starter job of a first run. The window then loads what
// the job installed.
func (s *Shell) startPlugins(done func(installed bool)) {
	s.pluginOperations.Refresh(func() {
		s.showStartFailures()
		s.refreshOutdated(func() {
			s.pluginOperations.InstallStarter(s.starter.Pack, s.starter.Registry, func(text string) {
				s.fail(fmt.Errorf("%s", text))
			}, done)
		})
	})
}

// laterCommand registers a command that the plugin operations answer.
func laterCommand[T any](s *Shell, name string, run func(value T, answer func(err error)) error) {
	s.registry.CommandLater(name, func(raw json.RawMessage, answer func(any, error)) {
		value, err := params[T](raw)
		if err != nil {
			answer(nil, Refuse(InvalidParams, "%s: %s", name, err))
			return
		}
		if err := run(value, func(err error) { answer(nil, err) }); err != nil {
			answer(nil, err)
		}
	})
}

// registerPlugins adds the statuses and the commands of the plugin operations.
func (s *Shell) registerPlugins() {
	s.registry.Status("core.plugins", func() any { return s.pluginOperations.Status() })
	s.registry.Status("core.app", func() any { return s.appUpdates.Status() })
	operation := func(action string) func(value pluginParam, answer func(err error)) error {
		return func(value pluginParam, answer func(err error)) error {
			if value.Plugin == "" {
				return Refuse(InvalidParams, "plugin must be a non-empty string")
			}
			// An install, update or enable that a running service holds runs with end, which ends that service
			// (docs/spec/persistent-services.md#updates).
			ends := action == "install" || action == "update" || action == "enable"
			if ends && value.End != nil && !*value.End {
				return Refuse(InvalidParams, "end must be true")
			}
			s.pluginOperations.Run(action, value.Plugin, ends && value.End != nil, answer)
			return nil
		}
	}
	laterCommand(s, "core.plugins.install", operation("install"))
	laterCommand(s, "core.plugins.update", operation("update"))
	laterCommand(s, "core.plugins.remove", operation("remove"))
	laterCommand(s, "core.plugins.enable", operation("enable"))
	laterCommand(s, "core.plugins.disable", operation("disable"))
	laterCommand(s, "core.plugins.update-all", func(_ struct{}, answer func(err error)) error {
		s.pluginOperations.UpdateAll(answer)
		return nil
	})
	laterCommand(s, "core.plugins.replace", func(value struct {
		Sidecar string `json:"sidecar"`
	}, answer func(err error)) error {
		if value.Sidecar == "" {
			return Refuse(InvalidParams, "sidecar must be a non-empty string")
		}
		s.pluginOperations.Replace(value.Sidecar, answer)
		return nil
	})
	laterCommand(s, "core.plugins.registry", func(value struct {
		Index string `json:"index"`
	}, answer func(err error)) error {
		if value.Index == "" {
			return Refuse(InvalidParams, "index must be a non-empty string")
		}
		s.pluginOperations.UseRegistry(value.Index, func(err error) {
			// The command answers after the read of the application update of the index, as the page answers after
			// appUpdate.refresh, so the frame that it answers after shows that update.
			s.appUpdates.Refresh(func() { answer(err) })
		})
		return nil
	})
	laterCommand(s, "core.app.update", func(_ struct{}, answer func(err error)) error {
		s.appUpdates.Update(answer)
		return nil
	})
	laterCommand(s, "core.app.release", func(_ struct{}, answer func(err error)) error {
		s.appUpdates.OpenRelease(answer)
		return nil
	})
	act(s, "core.plugins.browse", func(struct{}) error { return s.showSettingsPage("installed", "") })
	act(s, "core.plugins.show-updates", func(struct{}) error { return s.showSettingsPage("installed", "updates") })
}

// pluginStarter is what the environment declaration says of the first run: the starter pack and the default registry index.
type pluginStarter struct {
	Pack     *string `json:"starter"`
	Registry *string `json:"registry"`
}

// drawPluginPlaceholder draws the tab tab of a plugin that the window did not load: the reason, and the install or enable button
// when that is what the tab waits for.
func (s *Shell) drawPluginPlaceholder(c *ui.Context, tab layout.Tab) {
	reason := s.placeholderReason(tab.Plugin)
	line, action, label := placeholderOf(tab.Plugin, reason, s.requirers[tab.Plugin], reason == "missing" && s.registryListsPlugin(tab.Plugin))
	// The line is a paragraph of the page, whose margin of one line stands under it as well as the gap of the placeholder.
	gap := s.options.Declared.ChromeNumber("placeholder-gap", "px")
	ui.Column(c).Fill().Gap(float32(gap) + s.textBody()).Center().Children(func() {
		ui.Text(c, line).LineHeight(s.metrics.lineHeight).FontSize(s.textBody()).TextColor(s.palette.Muted)
		if action != "" {
			command := "core.plugins." + action
			s.uiButton(c, s.binder.Press(c, "core.card.placeholder-action", command, tab.Plugin, pluginParam{Plugin: tab.Plugin}), label, false)
		}
	})
}

// placeholderRows returns the entries of core.surfaces of the placeholder tabs of the plane: the active tab of each shown card whose
// plugin the window did not load, in card order. They follow the plane, not a drawn frame, so a read right after a reload, before
// the first frame, lists them too.
func (s *Shell) placeholderRows() ([]placeholderStatus, error) {
	var rows []placeholderStatus
	if s.plane == nil {
		return rows, nil
	}
	for _, card := range s.contentCards() {
		if s.fullscreen != "" && card.ID != s.fullscreen {
			continue
		}
		data, err := layout.DecodeCardData(card.Data)
		if err != nil {
			return nil, fmt.Errorf("card %s: %w", card.ID, err)
		}
		active := data.ActiveTab()
		if active == nil || s.units[active.Plugin] != nil {
			continue
		}
		rows = append(rows, placeholderStatus{Surface: active.ID, Plugin: active.Plugin, Visible: true, Placeholder: s.placeholderReason(active.Plugin),
			Kind: "tab"})
	}
	return rows, nil
}

// placeholderReason returns the reason of the placeholder of a tab of plugin (docs/spec/plugins.md): unread when the install state
// was not read, missing when the plugin is not installed, refused when its installed version was refused, requires when it is enabled
// and requires a plugin category that no loaded plugin serves, reload when it is enabled and loads with the next window, and disabled
// otherwise.
func (s *Shell) placeholderReason(plugin string) string {
	if failure := s.pluginOperations.Failure(); failure != nil && failure.Kind == "state" {
		return "unread"
	}
	rows := s.pluginOperations.Status().Plugins
	index := slices.IndexFunc(rows, func(row PluginRow) bool { return row.ID == plugin })
	switch {
	case index < 0 || rows[index].Installed == nil:
		return "missing"
	case rows[index].State == "refused":
		return "refused"
	case rows[index].Installed.Enabled && s.requirers[plugin] != "":
		return "requires"
	case rows[index].Installed.Enabled:
		return "reload"
	}
	return "disabled"
}

// registryListsPlugin tells that the registry lists a version of plugin, so a missing plugin can be installed from its placeholder.
func (s *Shell) registryListsPlugin(plugin string) bool {
	rows := s.pluginOperations.Status().Plugins
	index := slices.IndexFunc(rows, func(row PluginRow) bool { return row.ID == plugin })
	return index >= 0 && rows[index].Latest != nil
}

// placeholderOf returns the line of the placeholder of plugin for reason, and its action and the label of the action when it has one:
// install for a missing plugin that is installable, and enable for a disabled one. category is the plugin category that plugin requires
// for the reason requires.
func placeholderOf(plugin, reason, category string, installable bool) (line, action, label string) {
	switch reason {
	case "unread":
		return plugin + " 플러그인의 설치 상태를 읽지 못했습니다.", "", ""
	case "missing":
		if installable {
			return plugin + " 플러그인이 설치되어 있지 않습니다.", "install", "설치"
		}
		return plugin + " 플러그인이 설치되어 있지 않습니다.", "", ""
	case "refused":
		return plugin + " 플러그인의 설치된 버전을 불러오지 못했습니다.", "", ""
	case "requires":
		return plugin + " 플러그인에 필요한 " + category + " 플러그인이 없습니다.", "", ""
	case "reload":
		return "창을 다시 불러오면 " + plugin + " 플러그인이 열립니다.", "", ""
	}
	return plugin + " 플러그인을 사용하지 않습니다.", "enable", "사용"
}

// showStartFailures shows each failure of the update at start that the last read of the plugin state reported, through the error
// display (docs/spec/installation.md#update-at-start).
func (s *Shell) showStartFailures() {
	for _, failure := range s.pluginOperations.StartFailures() {
		s.errors.Show(failure.Where, failure.Text, "")
	}
}

// pluginUnits is the plugins of the window as the check of a stored layout reads them.
func (s *Shell) pluginUnits() []layout.PluginUnit {
	units := make([]layout.PluginUnit, 0, len(s.plugins))
	for _, plugin := range s.plugins {
		units = append(units, layout.PluginUnit{ID: plugin.ID, Surface: plugin.Surface})
	}
	return units
}
