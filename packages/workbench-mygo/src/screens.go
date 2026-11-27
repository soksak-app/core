package workbench

import "github.com/egoist/mygo/ui"

// The screens of the workbench are functions of values: each draws what it is given and runs commands only through a Binder, so a
// screen holds neither the registry nor a host call, and the shell connects both.

// elementName is the element name of the key of an element, or "" for a key that names none.
func elementName(key any) string {
	if named, ok := key.(Exposed); ok {
		return named.Name
	}
	return ""
}

// Name gives the next element of c its element name, for an element that runs no command. item tells it from the elements of the
// same name.
func (b *Binder) Name(c *ui.Context, name, item string) *ui.Context {
	if !b.registry.declared.Elements[name] {
		panic("element name " + name + " is not declared")
	}
	return c.Key(Exposed{Name: name, Item: item})
}

// drawSettingsTabHost draws the settings tab in the content rectangle under the title bar, the place that the work screen takes, while the
// tab is in front (docs/spec/settings.md#opening-and-closing). The host box is the element core.settings-tab, and the tab draws its
// content inside it at the origin of the box.
func (s *Shell) drawSettingsTabHost(c *ui.Context, width, height float32) {
	if !s.settingsTabInFront() {
		return
	}
	top := s.chromeHeight()
	body := max(0, height-top)
	s.exposedBox(c, "core.settings-tab", "", "").Absolute().Left(0).Top(top).Size(width, body).Role(ui.RoleGroup).Label("설정").Children(func() {
		s.drawSettingsTab(c, ui.Rect{W: width, H: body})
	})
}
