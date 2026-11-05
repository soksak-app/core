package workbench

import (
	"fmt"
	"math"
	"strconv"

	"github.com/egoist/mygo/ui"
)

// The drawing of the settings card from its model (settings_modal.go). The scrim and the card stand over the window, and only
// the close button closes the card (docs/spec/native-modals.md).

// settingsPane is what the card measures from its metrics.
type settingsPane struct {
	navW, headH, rowNameW, rowH, gap float32
}

func (s *Shell) readSettingsPane() settingsPane {
	metric := func(name string) float32 {
		value, _ := s.options.Declared.Metric(name)
		return float32(value)
	}
	return settingsPane{navW: metric("set-nav-w"), headH: metric("set-card-head-h"), rowNameW: metric("set-row-name-w"), rowH: metric("set-row-h"), gap: metric("set-group-gap")}
}

// drawSettings draws the scrim and the card over a window of width and height.
func (s *Shell) drawSettings(c *ui.Context, width, height float32) {
	w := &s.settingsWindow
	w.width, w.height = float64(width), float64(height)
	s.tellLanguage(c.Locale())
	if !w.open {
		return
	}
	model, err := s.settingsBuild()
	if err != nil {
		s.fail(err)
		return
	}
	if w.moved {
		s.clampCard()
	}
	x, y, cardW, cardH := s.settingsCard()
	pane := s.readSettingsPane()
	ui.Overlay(c, func() {
		scrim := s.exposedBox(c, "core.settings-modal.scrim", "", "")
		scrim.Absolute().Left(0).Top(0).Size(width, height).Modal().Role(ui.RoleGroup).Label("core.settings-modal.scrim")
		scrim.Children(func() {
			card := s.exposedBox(c, "core.settings-modal.card", "", "")
			card.Absolute().Left(float32(x)).Top(float32(y)).Size(float32(cardW), float32(cardH)).Column().Background(s.palette.Card).
				Border(s.palette.BorderWidth, s.palette.Edge).Radius(s.palette.Radius).Clip().Role(ui.RoleDialog).Label(settingsName).Children(func() {
				s.drawSettingsHead(c, model, float32(cardW), pane)
				ui.Row(c).Height(float32(cardH) - pane.headH).FillWidth().Children(func() {
					s.drawSettingsNav(c, model, pane)
					s.drawSettingsBody(c, model, float32(cardW)-pane.navW, pane)
				})
			})
		})
	})
}

// exposedBox is a box with an element name that takes no input.
func (s *Shell) exposedBox(c *ui.Context, name, command, item string) ui.Element {
	return ui.Box(c.Key(Exposed{Name: name, Command: command, Item: item}))
}

func (s *Shell) drawSettingsHead(c *ui.Context, model *settingsModel, width float32, pane settingsPane) {
	ui.Row(c).Size(width, pane.headH).PaddingX(16).AlignItems(ui.Center).BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Rule).Children(func() {
		grip := s.exposedBox(c, "core.settings-modal.grip", "core.settings-modal.move", "")
		grip.Grow(1).FillHeight().AlignItems(ui.Center).Row().Cursor(ui.CursorGrab).Role(ui.RoleGroup).Label(settingsName).Children(func() {
			ui.Text(c, settingsName).FontSize(13)
		})
		if dx, dy, pressed := grip.Dragged(); pressed && (dx != 0 || dy != 0) {
			s.binder.run("core.settings-modal.move", windowParam{DX: float64(dx), DY: float64(dy)})
		}
		s.drawButton(c, model.close)
	})
}

func (s *Shell) drawSettingsNav(c *ui.Context, model *settingsModel, pane settingsPane) {
	ui.Column(c).Width(pane.navW).FillHeight().Gap(2).Padding(10, 8).BorderWidth(0, s.palette.BorderWidth, 0, 0).BorderColor(s.palette.Rule).Children(func() {
		for _, control := range model.nav {
			s.drawButton(c, control)
		}
	})
}

func (s *Shell) drawSettingsBody(c *ui.Context, model *settingsModel, width float32, pane settingsPane) {
	w := &s.settingsWindow
	key := fmt.Sprint(w.section, w.scope, w.chosen, w.editing)
	if key != w.scrollKey {
		w.scrollKey, w.scroll.X, w.scroll.Y = key, 0, 0
	}
	ui.Scroll(c).TrackScroll(&w.scroll).Width(width).FillHeight().Children(func() {
		ui.Column(c).Width(width).Gap(pane.gap).Padding(14, 18, 18, 18).Children(func() {
			ui.Row(c).Gap(4).Role(ui.RoleGroup).Label("설정 범위").Children(func() {
				for _, control := range model.scopes {
					s.drawButton(c, control)
				}
			})
			if model.folder != "" {
				ui.Text(c, model.folder).TextColor(s.palette.Muted).FontSize(11)
			}
			for _, group := range model.groups {
				s.drawSettingsGroup(c, group, pane)
			}
		})
	})
}

func (s *Shell) drawSettingsGroup(c *ui.Context, group settingsGroup, pane settingsPane) {
	ui.Column(c).FillWidth().Gap(6).Role(ui.RoleGroup).Label(group.name).Children(func() {
		ui.Text(c, group.name).Bold().FontSize(12)
		ui.Text(c, group.text).Wrap().TextColor(s.palette.Muted).FontSize(11)
		for _, row := range group.rows {
			s.drawSettingsRow(c, row, pane)
		}
	})
}

func (s *Shell) drawSettingsRow(c *ui.Context, row settingsRow, pane settingsPane) {
	ui.Row(c).FillWidth().MinHeight(pane.rowH).Gap(12).AlignItems(ui.Center).Wrap().Children(func() {
		if row.name != "" {
			ui.Text(c, row.name).Width(pane.rowNameW).FontSize(12)
		}
		for _, control := range row.controls {
			s.drawControl(c, control)
		}
	})
	if row.description != "" {
		ui.Text(c, row.description).Wrap().TextColor(s.palette.Muted).FontSize(11)
	}
}

func (s *Shell) drawControl(c *ui.Context, control *SettingsControl) {
	switch control.kind {
	case controlButton:
		s.drawButton(c, control)
	case controlSwatch:
		s.drawSwatch(c, control)
	case controlSwitch:
		s.drawSwitch(c, control)
	case controlSelect:
		s.drawSelect(c, control)
	case controlSlider:
		s.drawSlider(c, control)
	case controlText:
		s.drawTextControl(c, control)
	case controlCaption:
		s.exposedBox(c, control.Name, "", "").Grow(1).Role(ui.RoleGroup).Label(control.Label).Children(func() {
			ui.Text(c, control.Label).Wrap().FontSize(11).TextColor(s.palette.Muted)
		})
	}
}

// item is the key of a control among those of its name.
func (c *SettingsControl) item() string {
	if c.Key == nil {
		return ""
	}
	return *c.Key
}

// run runs the command of the control, with value in its parameter when the control takes one.
func (s *Shell) runControl(control *SettingsControl, value any) {
	params := make(map[string]any, len(control.Command.Params)+1)
	for key, param := range control.Command.Params {
		params[key] = param
	}
	if control.param != "" {
		params[control.param] = value
	}
	s.binder.run(control.Command.Name, params)
}

func (s *Shell) drawButton(c *ui.Context, control *SettingsControl) {
	on := control.On != nil && *control.On
	button := s.binder.Press(c, control.Name, control.Command.Name, control.item(), control.Command.Params)
	button.PaddingX(8).Height(26).Radius(4).AlignItems(ui.Center).Label(control.Label).Children(func() {
		text := ui.Text(c, control.Label).FontSize(12)
		if !on {
			text.TextColor(s.palette.Muted)
		}
	})
	if on {
		button.Background(s.palette.Rule)
	}
}

func (s *Shell) drawSwatch(c *ui.Context, control *SettingsControl) {
	colors := control.theme.Dark
	if s.value("mode") == "light" {
		colors = control.theme.Light
	}
	border := ui.Hex(colors["edge"])
	if control.On != nil && *control.On {
		border = s.palette.Focus
	}
	button := s.binder.Press(c, control.Name, control.Command.Name, control.item(), control.Command.Params)
	button.Size(42, 42).Background(ui.Hex(colors["bg"])).Border(2, border).Radius(4).Padding(4).Row().Gap(2).Label(control.Label).Children(func() {
		ui.Box(c).Width(4).FillHeight().Background(ui.Hex(colors["rail"]))
		ui.Box(c).Grow(1).FillHeight().Background(ui.Hex(colors["card"])).Children(func() {
			ui.Box(c).Size(5, 5).Background(ui.Hex(colors["focus"]))
		})
	})
}

func (s *Shell) drawSwitch(c *ui.Context, control *SettingsControl) {
	on := control.On != nil && *control.On
	run := s.binder.Control(c, control.Name, control.Command.Name, control.item())
	if s.binder.Bound(ui.Switch(c, &on), control.Name).Label(control.Label).Changed() {
		params := make(map[string]any, len(control.Command.Params)+1)
		for key, param := range control.Command.Params {
			params[key] = param
		}
		params[control.param] = on
		run(params)
	}
}

func (s *Shell) drawSelect(c *ui.Context, control *SettingsControl) {
	value := *control.Value
	s.binder.Control(c, control.Name, control.Command.Name, control.item())
	selector := ui.SelectBase(c, &value)
	s.binder.Bound(selector.Trigger, control.Name)
	selector.Trigger.PaddingX(8).Height(26).Radius(4).Border(s.palette.BorderWidth, s.palette.Edge).AlignItems(ui.Center).Label(control.item()).Children(func() {
		ui.Text(c, control.labels[value]).FontSize(12).NoWrap()
	})
	selector.Popup(func(panel ui.Element) {
		panel.Padding(4).Background(s.palette.Card).Border(s.palette.BorderWidth, s.palette.Edge).Radius(4)
		option := func(id string) {
			item := selector.Item(id).PaddingX(8).Height(24).AlignItems(ui.Center)
			if item.Highlighted() {
				item.Background(s.palette.Rule)
			}
			item.Children(func() { ui.Text(c, control.labels[id]).FontSize(12) })
		}
		if control.Groups == nil {
			for _, id := range control.Options {
				option(id)
			}
			return
		}
		for _, group := range control.Groups {
			ui.Text(c, group.Label).FontSize(11).TextColor(s.palette.Muted)
			for _, id := range group.Values {
				option(id)
			}
		}
	})
	if selector.Trigger.Changed() {
		s.runControl(control, value)
	}
}

func (s *Shell) drawSlider(c *ui.Context, control *SettingsControl) {
	value, err := strconv.ParseFloat(*control.Value, 64)
	if err != nil {
		s.fail(fmt.Errorf("the setting %s is not a number: %s", control.item(), *control.Value))
		return
	}
	s.binder.Control(c, control.Name, control.Command.Name, control.item())
	slider := s.binder.Bound(ui.Slider(c, &value, control.lo, control.hi), control.Name).Label(control.item()).Grow(1)
	if slider.Changed() {
		s.runControl(control, math.Round(value))
	}
	ui.Text(c, *control.Value+control.unit).FontSize(11).TextColor(s.palette.Muted)
}

// drawTextControl draws a one-line field. A setting takes its text when the field submits or loses the focus, as the change
// of an input does, and the search takes each change.
func (s *Shell) drawTextControl(c *ui.Context, control *SettingsControl) {
	w := &s.settingsWindow
	key := control.item()
	value, drafted := w.drafts[key]
	if !drafted {
		value = *control.Value
	}
	s.binder.Control(c, control.Name, control.Command.Name, key)
	field := s.binder.Bound(ui.TextInput(c, &value), control.Name).Label(key).Placeholder(control.Label).Grow(1).FontSize(12)
	if field.Changed() {
		if control.searchable {
			s.runControl(control, value)
			return
		}
		w.drafts[key] = value
		drafted = true
	}
	if drafted && (field.Submitted() || !field.Focused()) {
		delete(w.drafts, key)
		s.runControl(control, value)
	}
}
