package workbench

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
)

// The drawing of the settings card from its model (settings_modal.go). The scrim and the card stand over the window, and only
// the close button closes the card (docs/spec/native-modals.md).

// settingsPane is what the card measures from its metrics.
type settingsPane struct {
	navW, navGap, navPadY, navPadX, navItemPadY, navItemPadX, navMarkInset, navMarkW, navMarkR float32
	headH, headGap, headPadStart, headPadEnd                                                   float32
	shadowY, shadowBlur, shadowAlpha                                                           float32
	rowNameW, rowH, gap                                                                        float32
	segGap, segPad, segButtonPadY, segButtonPadX                                               float32
	scopeGap, scopePadY, scopePadX, scopeMark, nameGap, captionGap, lineHeight, tracking       float32
	paneTop, paneX, paneBottom, rowGap, fieldPadY, buttonPadX, fieldPadX, arrowInset           float32
	swatchMinW, swatchW, gridGap, gridMargin, swatchGap, swatchPad, boxH, boxBorder            float32
	railW, pairLeft, pairInset, dotInset, dot                                                  float32
	focusOutline, focusOffset                                                                  float32
	switchW, switchH, knobInset, knob, knobOn, switchOnMix, slideGap, trackH, thumb            float32
}

func (s *Shell) readSettingsPane() settingsPane {
	metric := func(name string) float32 {
		return float32(s.options.Declared.ChromeNumber(name, "px"))
	}
	return settingsPane{
		navW: metric("set-nav-w"), navGap: metric("set-nav-gap"), navPadY: metric("set-nav-pad-y"), navPadX: metric("set-nav-pad-x"),
		navItemPadY: metric("set-nav-item-pad-y"), navItemPadX: metric("set-nav-item-pad-x"),
		navMarkInset: metric("set-nav-mark-inset"), navMarkW: metric("set-nav-mark-w"), navMarkR: metric("set-nav-mark-r"),
		headH: metric("set-card-head-h"), headGap: metric("set-card-head-gap"), headPadStart: metric("set-card-head-pad-start"), headPadEnd: metric("set-card-head-pad-end"),
		shadowY: metric("set-card-shadow-y"), shadowBlur: metric("set-card-shadow-blur"), shadowAlpha: metric("set-card-shadow-alpha"),
		rowNameW: metric("set-row-name-w"), rowH: metric("set-row-h"), gap: metric("set-group-gap"),
		segGap: metric("seg-gap"), segPad: metric("seg-pad"), segButtonPadY: metric("seg-button-pad-y"), segButtonPadX: metric("seg-button-pad-x"),
		scopeGap: metric("space-4"), scopePadY: metric("space-2"), scopePadX: metric("space-1"), scopeMark: metric("scope-tab-mark"),
		paneTop: metric("set-pane-pad-top"), paneX: metric("set-pane-pad-x"), paneBottom: metric("set-pane-pad-bottom"), rowGap: metric("set-row-gap"),
		fieldPadY: metric("field-pad-y"), buttonPadX: metric("space-3"), fieldPadX: metric("space-2"), arrowInset: metric("select-arrow-inset"),
		swatchMinW: metric("theme-swatch-min-w"), gridGap: metric("theme-grid-gap"), gridMargin: metric("theme-grid-margin"), swatchGap: metric("theme-swatch-gap"),
		swatchPad: metric("theme-swatch-pad"), boxH: metric("theme-box-h"), boxBorder: metric("theme-box-border"), railW: metric("theme-rail-w"),
		pairLeft: metric("theme-pair-left"), pairInset: metric("theme-pair-inset"), dotInset: metric("theme-dot-inset"), dot: metric("theme-dot"),
		switchW: metric("switch-w"), switchH: metric("switch-h"), knobInset: metric("switch-knob-inset"), knob: metric("switch-knob"), knobOn: metric("switch-knob-on"),
		switchOnMix: s.chromePercent("switch-on-mix"), slideGap: metric("slide-gap"), trackH: metric("slide-track-h"), thumb: metric("slide-thumb"),
		focusOffset: metric("switch-focus-offset"),
		nameGap:     metric("space-1"), captionGap: metric("set-caption-gap"), lineHeight: metric("line-height"), tracking: s.sectionTracking(),
	}
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
	x, y, cardW, _ := s.settingsCard()
	pane := s.readSettingsPane()
	ui.Overlay(c, func() {
		scrim := s.binder.Watched(s.exposedBox(c, "core.settings-modal.scrim", "", ""))
		scrim.Absolute().Left(0).Top(0).Size(width, height).Background(s.dialogScrim()).KeepAll().Modal().Role(ui.RoleGroup).Label("core.settings-modal.scrim")
		scrim.Children(func() {
			card := s.exposedBox(c, "core.settings-modal.card", "", "")
			// The card takes the focus of the dialog, so a key presses no control before Tab or a press reaches one.
			card.Focusable().FocusRing(false).LineHeight(pane.lineHeight)
			// The card ends with its content, and past its largest height the pane scrolls, as a card with max-height does.
			w.drawnHeight = float64(card.Bounds().H)
			card.Absolute().Left(float32(x)).Top(float32(y)).Width(float32(cardW)).Column().Background(s.palette.Card).
				Border(s.palette.BorderWidth, s.palette.Edge).Radius(s.radiusMiddle()).Clip().Shadow(0, pane.shadowY, pane.shadowBlur, 0, ui.RGBA(0, 0, 0, pane.shadowAlpha)).
				Role(ui.RoleDialog).Label(settingsName).Children(func() {
				// The border of the card takes its width and height from the content.
				border := 2 * s.palette.BorderWidth
				s.drawSettingsHead(c, model, float32(cardW)-border, pane)
				ui.Row(c).FillWidth().AlignItems(ui.Stretch).Children(func() {
					s.drawSettingsNav(c, model, pane)
					s.drawSettingsBody(c, model, float32(cardW)-border-pane.navW, float32(s.settingsCardMost())-border-pane.headH, pane)
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
	// The whole head moves the card, as the header of the page does, and the button that closes it stands inside.
	grip := s.exposedBox(c, "core.settings-modal.grip", "core.settings-modal.move", "")
	grip.Size(width, pane.headH).Padding(0, pane.headPadEnd, 0, pane.headPadStart).Gap(pane.headGap).Row().AlignItems(ui.Center).
		BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Edge).Cursor(ui.CursorGrab).Role(ui.RoleGroup).Label(settingsName).Children(func() {
		ui.Text(c, settingsName).Grow(1).FontSize(s.textControl()).TextColor(s.palette.Fg)
		closing := model.close
		s.drawAct(c, s.binder.Press(c, closing.Name, closing.Command.Name, closing.item(), closing.Command.Params), closing.Label, "close", false, 1)
	})
	if dx, dy, pressed := grip.Dragged(); pressed && (dx != 0 || dy != 0) {
		s.binder.run("core.settings-modal.move", windowParam{DX: float64(dx), DY: float64(dy)})
	}
}

func (s *Shell) drawSettingsNav(c *ui.Context, model *settingsModel, pane settingsPane) {
	ui.Column(c).Width(pane.navW).Gap(pane.navGap).Padding(pane.navPadY, pane.navPadX).BorderWidth(0, s.palette.BorderWidth, 0, 0).BorderColor(s.palette.Edge).Children(func() {
		for _, control := range model.nav {
			s.drawSettingsNavItem(c, control, pane)
		}
	})
}

// drawSettingsNavItem draws a section of the window, the .set-nav of packages/workbench/app.css: the shown section has a mark on its left.
func (s *Shell) drawSettingsNavItem(c *ui.Context, control *SettingsControl, pane settingsPane) {
	on := control.On != nil && *control.On
	button := s.binder.Press(c, control.Name, control.Command.Name, control.item(), control.Command.Params)
	button.FillWidth().Padding(pane.navItemPadY, pane.navItemPadX).Radius(s.radiusSmall()).Row().Justify(ui.Start).AlignItems(ui.Center).Label(control.Label)
	color := s.palette.Muted
	if button.Hovered() {
		color = s.palette.Fg
		button.Background(faded(s.palette.Fg, s.metrics.insetMix))
	}
	if on {
		color = s.palette.Fg
		button.Background(faded(s.palette.Fg, s.metrics.chipSelMix))
	}
	button.Children(func() {
		if on {
			ui.Box(c).Absolute().Left(0).Top(pane.navMarkInset).Bottom(pane.navMarkInset).Width(pane.navMarkW).Radius(pane.navMarkR).Background(s.palette.Rail)
		}
		ui.Text(c, control.Label).FontSize(s.textControl()).TextColor(color)
	})
}

func (s *Shell) drawSettingsBody(c *ui.Context, model *settingsModel, width, most float32, pane settingsPane) {
	w := &s.settingsWindow
	key := fmt.Sprint(w.section, w.scope, w.chosen, w.editing)
	if key != w.scrollKey {
		w.scrollKey, w.scroll.X, w.scroll.Y = key, 0, 0
	}
	ui.Scroll(c).TrackScroll(&w.scroll).Width(width).MaxHeight(most).Children(func() {
		ui.Column(c).Width(width).Padding(pane.paneTop, pane.paneX, pane.paneBottom, pane.paneX).Children(func() {
			ui.Row(c).FillWidth().Gap(pane.scopeGap).Margin(0, 0, pane.scopeGap, 0).BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Edge).Role(ui.RoleGroup).Label("설정 범위").Children(func() {
				for _, control := range model.scopes {
					s.drawSettingsScope(c, control, pane)
				}
			})
			if model.folder != "" {
				ui.Text(c, model.folder).TextColor(s.palette.Muted).FontSize(s.textSmall()).Margin(0, 0, pane.captionGap, 0)
			}
			// A grid of themes has as many columns of the least width as the pane holds, and they share the free width.
			inner := width - 2*pane.paneX
			columns := max(1, float32(math.Floor(float64((inner+pane.gridGap)/(pane.swatchMinW+pane.gridGap)))))
			pane.swatchW = (inner - pane.gridGap*(columns-1)) / columns
			for index, group := range model.groups {
				s.drawSettingsGroup(c, group, pane, index == len(model.groups)-1)
			}
		})
	})
}

// drawSettingsScope draws a scope of the window, the button of .set-scope-tabs of packages/workbench/app.css: the shown scope is
// underlined in the rail color.
func (s *Shell) drawSettingsScope(c *ui.Context, control *SettingsControl, pane settingsPane) {
	on := control.On != nil && *control.On
	button := s.binder.Press(c, control.Name, control.Command.Name, control.item(), control.Command.Params)
	button.Padding(pane.scopePadY, pane.scopePadX).Margin(0, 0, -s.palette.BorderWidth, 0).BorderWidth(0, 0, pane.scopeMark, 0).Label(control.Label)
	color := s.palette.Muted
	if button.Hovered() {
		color = s.palette.Fg
	}
	mark := ui.Transparent
	if on {
		color, mark = s.palette.Fg, s.palette.Rail
	}
	button.BorderColor(mark).Children(func() {
		ui.Text(c, control.Label).FontSize(s.textControl()).TextColor(color)
	})
}

func (s *Shell) drawSettingsGroup(c *ui.Context, group settingsGroup, pane settingsPane, last bool) {
	margin := pane.gap
	if last {
		margin = 0
	}
	ui.Column(c).FillWidth().Margin(0, 0, margin, 0).Role(ui.RoleGroup).Label(group.name).Children(func() {
		size := s.textCaption()
		ui.Text(c, group.name).Bold().FontSize(size).LetterSpacing(size*pane.tracking).TextColor(s.palette.Rail).Margin(0, 0, pane.nameGap, 0)
		ui.Text(c, group.text).Wrap().LineHeight(pane.lineHeight).TextColor(s.palette.Muted).FontSize(s.textSmall()).Margin(0, 0, pane.captionGap, 0)
		for _, row := range group.rows {
			s.drawSettingsRow(c, row, pane)
		}
	})
}

func (s *Shell) drawSettingsRow(c *ui.Context, row settingsRow, pane settingsPane) {
	if len(row.controls) > 0 && row.controls[0].kind == controlSwatch {
		ui.Row(c).FillWidth().Gap(pane.gridGap).Margin(0, 0, pane.gridMargin, 0).Wrap().Children(func() {
			for _, control := range row.controls {
				s.drawControl(c, control, pane)
			}
		})
		return
	}
	if len(row.controls) > 0 && row.controls[0].kind == controlCaption {
		// A row with a caption has the columns 1fr and auto, and its buttons stand in a segment at its end.
		ui.Row(c).FillWidth().MinHeight(pane.rowH).Gap(pane.rowGap).AlignItems(ui.Center).Children(func() {
			s.drawControl(c, row.controls[0], pane)
			ui.Row(c).Shrink(0).Gap(pane.segGap).Padding(pane.segPad).Border(s.palette.BorderWidth, s.palette.Edge).Radius(s.radiusSmall()).Background(s.palette.Bg).Children(func() {
				for _, control := range row.controls[1:] {
					s.drawSegmentButton(c, control, pane)
				}
			})
		})
		return
	}
	if row.list {
		ui.Row(c).FillWidth().Wrap().Children(func() {
			for _, control := range row.controls {
				s.drawControl(c, control, pane)
			}
		})
		return
	}
	// A row that wraps stacks its lines at its start, so a control stands in the middle of its row only in a row that does not.
	line := ui.Row(c).FillWidth().MinHeight(pane.rowH).Gap(pane.rowGap).AlignItems(ui.Center)
	if slices.ContainsFunc(row.controls, func(control *SettingsControl) bool { return strings.HasPrefix(control.item(), "reset:") }) {
		line.Wrap()
	}
	line.Children(func() {
		if row.name != "" {
			ui.Text(c, row.name).Width(pane.rowNameW).FontSize(s.textControl()).TextColor(s.palette.Muted)
		} else {
			// A row without a name keeps the empty name column of the grid of the page.
			ui.Box(c).Width(pane.rowNameW)
		}
		for _, control := range row.controls {
			s.drawControl(c, control, pane)
		}
	})
	if row.description != "" {
		ui.Text(c, row.description).Wrap().TextColor(s.palette.Muted).FontSize(s.textSmall()).Margin(0, 0, pane.captionGap, 0)
	}
}

func (s *Shell) drawControl(c *ui.Context, control *SettingsControl, pane settingsPane) {
	switch control.kind {
	case controlButton:
		s.drawButton(c, control, pane)
	case controlSwatch:
		s.drawSwatch(c, control, pane)
	case controlSwitch:
		s.drawSwitch(c, control, pane)
	case controlSelect:
		s.drawSelect(c, control, pane)
	case controlSlider:
		s.drawSlider(c, control, pane)
	case controlText:
		s.drawTextControl(c, control)
	case controlCaption:
		s.exposedBox(c, control.Name, "", "").Grow(1).Basis(0).Role(ui.RoleGroup).Label(control.Label).Children(func() {
			ui.Text(c, control.Label).Wrap().FontSize(s.textSmall()).TextColor(s.palette.Muted)
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

// drawButton draws a button, the .ui-button of packages/workbench/app.css. A button that is on has the fill of a chosen chip.
func (s *Shell) drawButton(c *ui.Context, control *SettingsControl, pane settingsPane) {
	on := control.On != nil && *control.On
	button := s.binder.Press(c, control.Name, control.Command.Name, control.item(), control.Command.Params)
	edge := s.palette.Edge
	if button.Hovered() {
		edge = s.palette.Rail
	}
	fill := s.palette.Bg
	if on {
		fill = faded(s.palette.Fg, s.metrics.chipSelMix)
	}
	button.Padding(pane.fieldPadY, pane.buttonPadX).Border(s.palette.BorderWidth, edge).Radius(s.radiusSmall()).Background(fill).AlignItems(ui.Center).Label(control.Label).Children(func() {
		ui.Text(c, control.Label).FontSize(s.textControl()).TextColor(s.palette.Fg)
	})
}

// drawSegmentButton draws a button of a segment, the .set-seg button of packages/workbench/app.css.
func (s *Shell) drawSegmentButton(c *ui.Context, control *SettingsControl, pane settingsPane) {
	button := s.binder.Press(c, control.Name, control.Command.Name, control.item(), control.Command.Params)
	color := s.palette.Muted
	if button.Hovered() {
		color = s.palette.Fg
	}
	if control.On != nil && *control.On {
		color = s.palette.Fg
		button.Background(faded(s.palette.Fg, s.metrics.chipSelMix))
	}
	button.Padding(pane.segButtonPadY, pane.segButtonPadX).Radius(s.radiusSmall()).AlignItems(ui.Center).Label(control.Label).Children(func() {
		ui.Text(c, control.Label).NoWrap().FontSize(s.textSmall()).TextColor(color)
	})
}

// drawSwatch draws a theme with its own values, the .th of packages/workbench/app.css: its background, rail, focus, and two cards with the
// passage and the radius of the theme.
func (s *Shell) drawSwatch(c *ui.Context, control *SettingsControl, pane settingsPane) {
	theme := control.theme
	colors := theme.Dark
	if s.value("mode") == "light" {
		colors = theme.Light
	}
	shape := func(name string) float64 {
		value, err := strconv.ParseFloat(strings.TrimSuffix(theme.Shape[name], "px"), 64)
		if err != nil {
			panic(fmt.Sprintf("the shape value %s of the theme %s is %q, not a number of px", name, theme.Name, theme.Shape[name]))
		}
		return value
	}
	// The box is small, so the passage is halved, and a theme without a passage keeps the line that its cards share.
	gap := shape("gap")
	slit, between := float32(max(2, math.Round(gap/2))), ui.Hex(colors["bg"])
	if gap == 0 {
		slit, between = 1, ui.Hex(colors["rule"])
	}
	radius := float32(min(shape("r")/2, 5))
	on := control.On != nil && *control.On
	button := s.binder.Press(c, control.Name, control.Command.Name, control.item(), control.Command.Params)
	name, frame := s.palette.Muted, ui.Transparent
	if button.Hovered() {
		name = s.palette.Fg
	}
	if on {
		name, frame = s.palette.Fg, s.palette.Focus
	}
	card := func(children func()) {
		ui.Box(c).Grow(1).FillHeight().Background(ui.Hex(colors["card"])).Border(pane.boxBorder, ui.Hex(colors["edge"])).Radius(radius).Children(children)
	}
	button.Width(pane.swatchW).Column().Gap(pane.swatchGap).Padding(pane.swatchPad).Border(s.palette.BorderWidth, frame).Radius(s.radiusSmall()).Label(control.Label).Children(func() {
		ui.Box(c).FillWidth().Height(pane.boxH).Background(ui.Hex(colors["bg"])).Border(pane.boxBorder, ui.Hex(colors["edge"])).Radius(s.radiusSmall()).Clip().Children(func() {
			ui.Box(c).Absolute().Left(0).Top(0).Bottom(0).Width(pane.railW).Background(ui.Hex(colors["rail"]))
			ui.Row(c).Absolute().Left(pane.pairLeft).Top(pane.pairInset).Right(pane.pairInset).Bottom(pane.pairInset).Gap(slit).Background(between).Children(func() {
				card(func() {
					ui.Box(c).Absolute().Right(pane.dotInset).Bottom(pane.dotInset).Size(pane.dot, pane.dot).Radius(pane.dot / 2).Background(ui.Hex(colors["focus"]))
				})
				card(func() {})
			})
		})
		ui.Text(c, control.Label).FontSize(s.textCaption()).TextColor(name).AlignSelf(ui.Center)
	})
}

// drawSwitch draws an on and off value, the .set-switch of packages/workbench/app.css.
func (s *Shell) drawSwitch(c *ui.Context, control *SettingsControl, pane settingsPane) {
	on := control.On != nil && *control.On
	run := s.binder.Control(c, control.Name, control.Command.Name, control.item())
	body := s.binder.Bound(ui.SwitchBase(c, &on), control.Name).Size(pane.switchW, pane.switchH).Label(control.Label)
	if body.Changed() {
		params := make(map[string]any, len(control.Command.Params)+1)
		for key, param := range control.Command.Params {
			params[key] = param
		}
		params[control.param] = on
		run(params)
	}
	track, knob, left := faded(s.palette.Fg, s.metrics.insetMix), s.palette.Muted, pane.knobInset
	if on {
		track, knob, left = faded(s.palette.Focus, pane.switchOnMix), s.palette.Focus, pane.knobOn
	}
	body.FocusRingOffset(pane.focusOffset)
	body.Radius(pane.switchH).Background(track).Children(func() {
		ui.Box(c).Absolute().Left(left).Top(pane.knobInset).Size(pane.knob, pane.knob).Radius(pane.knob / 2).Background(knob)
	})
}

func (s *Shell) drawSelect(c *ui.Context, control *SettingsControl, pane settingsPane) {
	value := *control.Value
	s.binder.Control(c, control.Name, control.Command.Name, control.item())
	selector := ui.SelectBase(c, &value)
	s.binder.Bound(selector.Trigger, control.Name)
	edge := s.palette.Edge
	if selector.Trigger.Hovered() {
		edge = s.palette.Rail
	}
	if selector.Trigger.Focused() {
		edge = s.palette.Focus
	}
	// .select-field select:focus-visible: the focus color on the border, without an outline.
	selector.Trigger.FocusRing(false).Grow(1).Row().Padding(pane.fieldPadY, pane.arrowInset, pane.fieldPadY, pane.fieldPadX).Radius(s.radiusSmall()).Border(s.palette.BorderWidth, edge).Background(s.palette.Bg).AlignItems(ui.Center).Label(control.Label).Children(func() {
		ui.Text(c, control.labels[value]).FontSize(s.textControl()).TextColor(s.palette.Fg).NoWrap().Grow(1)
		ui.Text(c, "▾").FontSize(s.textCaption()).TextColor(s.palette.Muted)
	})
	selector.Popup(func(panel ui.Element) {
		panel.Padding(pane.nameGap).Background(s.palette.Card).Border(s.palette.BorderWidth, s.palette.Edge).Radius(s.radiusSmall())
		option := func(id string) {
			item := selector.Item(id).Padding(pane.fieldPadY, pane.fieldPadX).AlignItems(ui.Center)
			if item.Highlighted() {
				item.Background(s.palette.Rule)
			}
			item.Children(func() { ui.Text(c, control.labels[id]).FontSize(s.textControl()) })
		}
		if control.Groups == nil {
			for _, id := range control.Options {
				option(id)
			}
			return
		}
		for _, group := range control.Groups {
			ui.Text(c, group.Label).FontSize(s.textSmall()).TextColor(s.palette.Muted)
			for _, id := range group.Values {
				option(id)
			}
		}
	})
	if selector.Trigger.Changed() {
		s.runControl(control, value)
	}
}

// drawSlider draws a bounded number, the .set-slide of packages/workbench/app.css.
func (s *Shell) drawSlider(c *ui.Context, control *SettingsControl, pane settingsPane) {
	value, err := strconv.ParseFloat(*control.Value, 64)
	if err != nil {
		s.fail(fmt.Errorf("the setting %s is not a number: %s", control.item(), *control.Value))
		return
	}
	ui.Row(c).Grow(1).Gap(pane.slideGap).AlignItems(ui.Center).Children(func() {
		s.binder.Control(c, control.Name, control.Command.Name, control.item())
		// The slider of the page is as tall as its track, and takes the pointer over the thumb that stands out of it.
		reach := (pane.thumb - pane.trackH) / 2
		slider := s.binder.Bound(ui.SliderBase(c, &value, control.lo, control.hi), control.Name).Label(control.item()).Grow(1).Height(pane.trackH).
			HitOutset(reach).PaddingX(pane.thumb / 2)
		if slider.Changed() {
			s.runControl(control, math.Round(value))
		}
		share := float32((value - control.lo) / (control.hi - control.lo))
		track, thumb, thumbColor, trackH := faded(s.palette.Fg, s.metrics.insetMix), pane.thumb, s.palette.Focus, pane.trackH
		slider.Draw(func(p *ui.Painter, r ui.Rect) {
			p.Fill(ui.Rect{X: r.X, Y: r.Y + (r.H-trackH)/2, W: r.W, H: trackH}, track, trackH/2)
			p.Fill(ui.Rect{X: r.X + (r.W-thumb)*share, Y: r.Y + (r.H-thumb)/2, W: thumb, H: thumb}, thumbColor, thumb/2)
		})
		// The browser rings the slider of the page around its track and the thumb that stands out of it.
		plain, ringed := s.plainControls(), slider.FocusVisible()
		ring := plain.ringColor(c)
		slider.FocusRing(false).DrawOver(func(p *ui.Painter, r ui.Rect) {
			if ringed {
				plain.ring(p, ui.Rect{X: r.X, Y: r.Y - reach, W: r.W, H: thumb}, thumb/2, ring)
			}
		})
		ui.Text(c, *control.Value+control.unit).Width(s.chLength(c, "slide-value-w", s.textSmall())).TextAlign(ui.End).FontSize(s.textSmall()).TextColor(s.palette.Muted)
	})
}

// drawTextControl draws a one-line field. A setting takes its text when the field submits or loses the focus, as the change
// of an input does, and the search takes each change.
func (s *Shell) drawTextControl(c *ui.Context, control *SettingsControl) {
	w := &s.settingsWindow
	key := control.item()
	if control.searchable {
		s.drawSearchControl(c, control)
		return
	}
	value, drafted := w.drafts[key]
	if !drafted {
		value = *control.Value
	}
	s.binder.Control(c, control.Name, control.Command.Name, key)
	field := s.plainControls().field(c, s.binder.Bound(ui.TextInputBase(c, &value), control.Name)).Label(key).Placeholder(control.Label).Grow(1)
	if field.Changed() {
		w.drafts[key] = value
		drafted = true
	}
	if drafted && (field.Submitted() || !field.Focused()) {
		delete(w.drafts, key)
		s.runControl(control, value)
	}
}

// drawSearchControl draws the search, which runs its command for each change and has the cancel of the browser while it has a text.
func (s *Shell) drawSearchControl(c *ui.Context, control *SettingsControl) {
	plain, value := s.plainControls(), *control.Value
	plain.searchBox(c).Children(func() {
		s.binder.Control(c, control.Name, control.Command.Name, control.item())
		field := plain.search(c, s.binder.Bound(ui.TextInputBase(c, &value), control.Name)).Label(control.item()).Placeholder(control.Label)
		if field.Changed() {
			s.runControl(control, value)
		}
		// The browser empties a search on Escape as its cancel does. An empty search leaves the key to the window.
		if value != "" && (plain.drawSearchCancel(c) || field.Shortcut(0, ui.KeyEscape)) {
			s.runControl(control, "")
		}
	})
}
