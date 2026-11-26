package workbench

import (
	"encoding/json"

	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// settingsSurface is the settings surface of a plugin (docs/spec/plugins.md#settings-views): the page of its settings view, which the plugin
// page of the settings window shows at its seat. It exists while the settings window shows that page.
type settingsSurface struct {
	surface *heldSurface
	plugin  string
}

// id is the surface id of the settings surface, settings/<plugin>.
func (v *settingsSurface) id() string { return v.surface.tab.ID }

// settingsSurfaceID is the surface id of the settings surface of plugin.
func settingsSurfaceID(plugin string) string { return "settings/" + plugin }

// settingsErrorPlace is the place of the error display of the settings surface of plugin.
func settingsErrorPlace(plugin string) string { return "settings " + plugin }

// shownSettingsView is the plugin whose settings view the settings window shows, or "": the settings window is open on the plugin page
// of a plugin that declares a settings view.
func (s *Shell) shownSettingsView() string {
	w := &s.settingsWindow
	if !w.open || w.section != "plugins" || w.chosen == "" {
		return ""
	}
	if unit := s.units[w.chosen]; unit != nil && unit.SettingsView != nil {
		return w.chosen
	}
	return ""
}

// followSettingsSurface makes the settings surface of the frame the one of the shown settings view: a page that the window leaves ends its
// surface, and a page that it shows creates one. A settings surface whose view stopped its restarts is created again only after the window
// shows its page again.
func (s *Shell) followSettingsSurface() {
	w := &s.settingsWindow
	plugin := s.shownSettingsView()
	if plugin != w.viewPage {
		w.viewPage, w.viewStopped = plugin, false
	}
	if s.settingsView != nil && (s.settingsView.plugin != plugin || w.viewStopped) {
		s.endSettingsSurface()
	}
	if plugin == "" || w.viewStopped || s.settingsView != nil {
		return
	}
	declaration := s.units[plugin].SettingsView
	composition, err := json.Marshal(struct {
		Kind    string          `json:"kind"`
		Page    string          `json:"page"`
		Regions json.RawMessage `json:"regions,omitempty"`
	}{"view", declaration.Page, declaration.Regions})
	if err != nil {
		s.fail(err)
		return
	}
	s.errors.Hide(settingsErrorPlace(plugin))
	s.settingsView = &settingsSurface{plugin: plugin, surface: &heldSurface{
		tab:         layout.Tab{ID: settingsSurfaceID(plugin), Plugin: plugin, Rest: map[string]json.RawMessage{"params": json.RawMessage("null")}},
		composition: composition,
	}}
}

// endSettingsSurface removes the settings surface: the next placement leaves it out, which closes its view, and the keyboard returns to
// the settings window.
func (s *Shell) endSettingsSurface() {
	if s.settingsView == nil {
		return
	}
	id := s.settingsView.id()
	s.settingsView = nil
	s.settingsWindow.viewKeys = false
	s.forgetSurfaces([]string{id})
	s.options.Invalidate()
}

// failSettingsSurface ends the settings surface whose view stopped its restarts: the error display shows the reason at settings <plugin>
// until the window shows the page of the plugin again (docs/spec/plugins.md#settings-views).
func (s *Shell) failSettingsSurface(reason string) {
	plugin := s.settingsView.plugin
	s.settingsWindow.viewStopped = true
	s.endSettingsSurface()
	s.errors.Show(settingsErrorPlace(plugin), reason, "")
}

// isSettingsSurface tells whether surface is the open settings surface.
func (s *Shell) isSettingsSurface(surface string) bool {
	return s.settingsView != nil && s.settingsView.id() == surface && host.IsSettingsSurface(surface)
}

// drawSettingsSeat draws the seat of the settings view in the plugin page: the element core.settings-modal.plugin-view in the width of the
// pane and the height of its visible box, which holds the native view of the settings surface. The seat of the frame is the bounds of the
// element clipped to the bounds of the pane in the last frame; a change of either draws the frame again, so a scroll and a resize of the
// window measure it again (docs/spec/native-surfaces.md#settings-seat).
func (s *Shell) drawSettingsSeat(c *ui.Context, height float32) {
	view := s.settingsView
	seat := s.exposedBox(c, "core.settings-modal.plugin-view", "", "")
	seat.FillWidth().Height(height).Role(ui.RoleGroup).Label("설정 view")
	if view == nil {
		return
	}
	id := view.id()
	window, err := s.windowView()
	if err != nil {
		s.failWindowRead(err)
		return
	}
	bounds, pane := seat.Bounds(), s.settingsWindow.paneBounds
	left, top := max(bounds.X, pane.X), max(bounds.Y, pane.Y)
	right, bottom := min(bounds.X+bounds.W, pane.X+pane.W), min(bounds.Y+bounds.H, pane.Y+pane.H)
	box := DevicePixels(layout.Rect{X: float64(bounds.X), Y: float64(bounds.Y), W: float64(bounds.W), H: float64(bounds.H)}, window.Scale)
	clip := DevicePixels(layout.Rect{X: float64(pane.X), Y: float64(pane.Y), W: float64(pane.W), H: float64(pane.H)}, window.Scale)
	if box != view.surface.box || view.surface.clip == nil || clip != *view.surface.clip {
		view.surface.box, view.surface.clip = box, &clip
		s.options.Invalidate()
	}
	if right > left && bottom > top && bounds.W > 0 {
		s.surfaces.drawn[id] = box
	} else {
		delete(s.surfaces.drawn, id)
	}
	s.holdSurface(view.surface)
	element, key, ok := s.options.Element(id)
	if !ok {
		return
	}
	seat.Children(func() {
		ui.NativeView(c, element, key).FillWidth().FillHeight().ObserveInput(func(ev ui.InputEvent) {
			if ev.Kind == ui.InputPointerDown {
				s.pressSurface(id)
			}
		})
	})
}
