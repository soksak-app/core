package workbench

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
)

// The drawing of the settings card from its model (settings_tab_view.go). The scrim and the card stand over the window, and only
// the close button closes the card (docs/spec/native-modals.md).

// settingsPane is what the card measures from its metrics.
type settingsPane struct {
	navW, navGap, navPadY, navPadX, navItemPadY, navItemPadX, navMarkInset, navMarkW, navMarkR float32
	headH, headGap, headPadStart, headPadEnd                                                   float32
	shadowY, shadowBlur, shadowAlpha                                                           float32
	controlW, rowH, gap, indent                                                                float32
	segGap, segPad, segButtonPadY, segButtonPadX                                               float32
	scopeGap, scopePadY, scopePadX, scopeMark, nameGap, captionGap, lineHeight, tracking       float32
	paneTop, paneX, paneBottom, rowGap, fieldPadY, buttonPadX, fieldPadX, arrowInset           float32
	// fieldH is the height of an input and a select, and buttonSmH the height of a small button (docs/spec/settings.md#controls).
	fieldH, buttonSmH                                                               float32
	swatchMinW, gridGap, gridMargin, swatchGap, swatchPad, boxH, boxBorder          float32
	railW, pairLeft, pairInset, dotInset, dot                                       float32
	focusOutline, focusOffset                                                       float32
	switchW, switchH, knobInset, knob, knobOn, switchOnMix, slideGap, trackH, thumb float32
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
		controlW: metric("set-control-w"), rowH: metric("set-row-h"), gap: metric("set-group-gap"),
		indent: metric("space-3"),
		segGap: metric("seg-gap"), segPad: metric("seg-pad"), segButtonPadY: metric("seg-button-pad-y"), segButtonPadX: metric("seg-button-pad-x"),
		scopeGap: metric("space-4"), scopePadY: metric("space-2"), scopePadX: metric("space-1"), scopeMark: metric("scope-tab-mark"),
		paneTop: metric("set-pane-pad-top"), paneX: metric("set-pane-pad-x"), paneBottom: metric("set-pane-pad-bottom"), rowGap: metric("space-2"),
		fieldH: metric("field-h"), buttonSmH: metric("button-sm-h"), fieldPadY: metric("field-pad-y"), buttonPadX: metric("space-3"), fieldPadX: metric("space-2"), arrowInset: metric("select-arrow-inset"),
		swatchMinW: metric("theme-swatch-min-w"), gridGap: metric("theme-grid-gap"), gridMargin: metric("theme-grid-margin"), swatchGap: metric("theme-swatch-gap"),
		swatchPad: metric("theme-swatch-pad"), boxH: metric("theme-box-h"), boxBorder: metric("theme-box-border"), railW: metric("theme-rail-w"),
		pairLeft: metric("theme-pair-left"), pairInset: metric("theme-pair-inset"), dotInset: metric("theme-dot-inset"), dot: metric("theme-dot"),
		switchW: metric("switch-w"), switchH: metric("switch-h"), knobInset: metric("switch-knob-inset"), knob: metric("switch-knob"), knobOn: metric("switch-knob-on"),
		switchOnMix: s.chromePercent("switch-on-mix"), slideGap: metric("slide-gap"), trackH: metric("slide-track-h"), thumb: metric("slide-thumb"),
		focusOffset: metric("switch-focus-offset"),
		nameGap:     metric("space-1"), captionGap: metric("set-caption-gap"), lineHeight: metric("line-height"), tracking: s.sectionTracking(),
	}
}

// settingsForFrame updates the model of the tab before the window chooses its foreground focus scope. The model is built again only when
// its key changed (docs/spec/settings.md#performance).
func (s *Shell) settingsForFrame(c *ui.Context, width, height float32) {
	w := &s.settingsTab
	w.width, w.height = float64(width), float64(height)
	w.locale = c.Locale()
	s.tellLanguage(w.locale)
	// Showing the agent page reads the setup parts (docs/spec/settings.md#agents); the page stands in the common scope while no
	// project is selected.
	s.setupOperations.Show(w.open && w.page == "agents" && (w.scope == "common" || s.settings.Project() == ""))
	// Showing the plugin page reads the accounts of the plugin (docs/spec/plugins.md#accounts).
	shown := ""
	if w.open && w.page == "plugin" {
		shown = w.chosen
	}
	s.accounts.Show(shown)
	if !w.open {
		w.model = nil
		return
	}
	if _, err := s.settingsModelNow(); err != nil {
		s.closeSettings()
		s.setupOperations.Show(false)
		s.accounts.Show("")
		s.fail(err)
	}
}

// settingsModelNow returns the model of the current state. It builds the model only when the key of the state changed.
func (s *Shell) settingsModelNow() (*settingsModel, error) {
	w := &s.settingsTab
	key := s.settingsKeyOf(w.locale)
	if w.model != nil && w.key == key {
		return w.model, nil
	}
	model, err := s.settingsBuild()
	if err != nil {
		return nil, err
	}
	w.model, w.key = model, key
	return model, nil
}

// settingsKeyOf returns the key of the model of the current state. The plugins are fixed for the life of the window, so len(s.plugins)
// is a sufficient key.
func (s *Shell) settingsKeyOf(locale string) settingsKey {
	w := &s.settingsTab
	// The operation of a plugin is part of the key, so a running action and its end redraw the plugin rows (docs/spec/settings.md#plugins).
	var operation PluginOperation
	if current := s.pluginOperations.Status().Operation; current != nil {
		operation = *current
	}
	return settingsKey{
		inputs: w.inputs, setup: s.setupOperations.Generation(), plugins: len(s.plugins), operation: operation,
		locale: locale, project: s.settings.Project(),
		page: w.page, scope: w.scope, query: w.query, find: w.find, filter: w.filter, chosen: w.chosen, editing: w.editing, browse: w.browse, confirm: w.confirm,
		accountPlugin: w.accountPlugin, accountName: w.accountName, accountKind: w.accountKind,
		accountEdit: w.accountEdit, accountEditName: w.accountEditName,
	}
}

// drawSettingsTab draws the settings tab into rect of the frame while the tab is in front (settingsTabInFront). The menu stands at the
// left of the rect and the page at its right; the tab has no scrim, no card and no drag (docs/spec/settings.md#opening-and-closing).
func (s *Shell) drawSettingsTab(c *ui.Context, rect ui.Rect) {
	model := s.settingsTab.model
	if !s.settingsTabInFront() || model == nil {
		return
	}
	pane := s.readSettingsPane()
	tab := s.exposedBox(c, "core.settings-tab", "", "")
	tab.Absolute().Left(rect.X).Top(rect.Y).Size(rect.W, rect.H).Background(s.palette.Card).Clip().Row().Children(func() {
		s.drawSettingsMenu(c, model, pane)
		ui.Column(c).FillWidth().Children(func() {
			width := rect.W - pane.navW
			foot := s.settingsFootHeight(pane)
			s.drawSettingsHead(c, model, width, pane)
			s.drawSettingsBody(c, model, width, rect.H-s.settingsHeadHeight(pane)-foot, pane)
			if s.settingsTab.undo != nil {
				s.drawSettingsToast(c, width, foot, pane)
			}
		})
	})
}

// exposedBox is a box with an element name that takes no input.
func (s *Shell) exposedBox(c *ui.Context, name, command, item string) ui.Element {
	return ui.Box(c.Key(Exposed{Name: name, Command: command, Item: item}))
}

// settingsFootHeight is the height of the foot of the tab, which holds the undo toast while one is shown, and 0 otherwise. The foot is
// the button height between the paddings of the pane (docs/spec/settings.md#saving-and-undo).
func (s *Shell) settingsFootHeight(pane settingsPane) float32 {
	if s.settingsTab.undo == nil {
		return 0
	}
	return s.metrics.actH + pane.paneTop + pane.paneBottom
}

// drawSettingsToast draws the undo toast in the foot of the tab: its text and the Undo button, which runs core.settings-tab.undo
// (docs/spec/settings.md#saving-and-undo).
func (s *Shell) drawSettingsToast(c *ui.Context, width, height float32, pane settingsPane) {
	toast := s.settingsTab.undo
	text := toast.text
	// The row is a status with the text as its label, so the element tree keeps it (an unnamed container is not kept).
	row := ui.Row(s.binder.Name(c, "core.settings-tab.toast", "")).Role(ui.RoleStatus).Label(text).Size(width, height).Padding(pane.paneTop, pane.paneX, pane.paneBottom, pane.paneX)
	row.AlignItems(ui.Center).Gap(pane.rowGap).Children(func() {
		ui.Text(c, text).SingleLine().Ellipsis("…").MinWidth(0).Grow(1).Basis(0).FontSize(s.textControl()).TextColor(s.palette.Fg)
		s.uiButton(c, s.binder.Press(c, "core.settings-tab.undo", "core.settings-tab.undo", "", windowParam{}), "되돌리기", false)
	})
}

// settingsTabInFront tells whether the settings tab is in front. The chrome of the window draws the tab only while this is true.
func (s *Shell) settingsTabInFront() bool { return s.settingsTab.open }

// settingsHeadHeight is the height of the page head, which stays above the scrolling content.
func (s *Shell) settingsHeadHeight(pane settingsPane) float32 {
	return pane.headH
}

// drawSettingsHead draws the title of the page, its description and the scope control with the folder caption of the project scope.
func (s *Shell) drawSettingsHead(c *ui.Context, model *settingsModel, width float32, pane settingsPane) {
	w := &s.settingsTab
	head := ui.Column(c).Size(width, pane.headH).Padding(pane.paneTop, pane.paneX, 0, pane.paneX)
	head.Children(func() {
		ui.Text(c, settingsPageTitle(w)).FontSize(s.textControl()).TextColor(s.palette.Fg)
		if description := settingsPageDescription(w.page); description != "" {
			ui.Text(c, description).FontSize(s.textSmall()).TextColor(s.palette.Muted)
		}
		if model.headBadge != nil {
			ui.Row(c).FillWidth().Margin(0, 0, pane.scopeGap, 0).Children(func() {
				s.drawControl(c, model.headBadge, pane)
			})
		}
		if len(model.scopes) > 0 {
			ui.Row(c).FillWidth().Gap(pane.scopeGap).Margin(0, 0, pane.scopeGap, 0).BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Edge).Role(ui.RoleGroup).Label("설정 범위").Children(func() {
				for _, control := range model.scopes {
					s.drawSettingsScope(c, control, pane)
				}
			})
		}
		if model.folder != "" {
			ui.Text(s.binder.Name(c, "core.settings-tab.folder", ""), model.folder).LineHeight(s.metrics.lineHeight).TextColor(s.palette.Muted).FontSize(s.textSmall()).Margin(0, 0, pane.captionGap, 0)
		}
	})
}

// drawSettingsMenu draws the menu at the left of the tab: the pages Settings and Plugins, each as a button of its page.
func (s *Shell) drawSettingsMenu(c *ui.Context, model *settingsModel, pane settingsPane) {
	ui.Column(c).Width(pane.navW).Gap(pane.navGap).Padding(pane.navPadY, pane.navPadX).BorderWidth(0, s.palette.BorderWidth, 0, 0).BorderColor(s.palette.Edge).Children(func() {
		s.drawSearchControl(c, model.find)
		plugins := false
		for _, control := range model.nav {
			// The group of the plugin items has its title before its first item (docs/spec/settings.md#menu).
			if control.pluginItem && !plugins {
				plugins = true
				ui.Text(c, "설정이 있는 플러그인").FontSize(s.textCaption()).TextColor(s.palette.Muted)
			}
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
		if control.pluginItem {
			// The chevron comes before the name of a plugin item (docs/spec/settings.md#menu).
			ui.Icon(c, chevronRight).Size(s.textControl(), s.textControl())
		}
		ui.Text(c, control.Label).FontSize(s.textControl()).TextColor(color)
		if control.pluginItem {
			ui.Box(c).Grow(1)
		}
		if control.dot {
			// The dot of an enabled plugin uses the accent color, as .set-dot of packages/workbench/settings.css does; it stands at the end.
			ui.Box(c).Size(pane.navMarkW, pane.navMarkW).Radius(pane.navMarkR).Background(s.palette.Rail)
		}
		if control.Badge != "" {
			ui.Text(c, control.Badge).FontSize(s.textCaption()).TextColor(s.palette.Muted)
		}
	})
}

func (s *Shell) drawSettingsBody(c *ui.Context, model *settingsModel, width, most float32, pane settingsPane) {
	w := &s.settingsTab
	key := fmt.Sprint(w.page, w.scope, w.chosen, w.editing)
	if key != w.scrollKey {
		w.scrollKey, w.scroll.X, w.scroll.Y = key, 0, 0
	}
	scroll := ui.Scroll(c.Key(Exposed{Name: "core.settings-tab.pane"}))
	scroll.TrackScroll(&w.scroll).Width(width).MaxHeight(most).Children(func() {
		// The pane fills the room the scroll container gives it, beside its classic bar when the content overflows, as the pane of
		// packages/workbench/app.css does.
		ui.Column(c).FillWidth().Padding(pane.paneTop, pane.paneX, pane.paneBottom, pane.paneX).Children(func() {
			for index, group := range model.groups {
				reveal := group.name == w.revealGroup
				if reveal {
					w.revealGroup = ""
				}
				s.drawSettingsGroup(c, group, pane, index == len(model.groups)-1, reveal)
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

func (s *Shell) drawSettingsGroup(c *ui.Context, group settingsGroup, pane settingsPane, last, reveal bool) {
	margin := pane.gap
	if last {
		margin = 0
	}
	column := ui.Column(c).FillWidth().Margin(0, 0, margin, 0).Role(ui.RoleGroup).Label(group.name)
	if reveal {
		column = column.ScrollIntoView()
	}
	column.Children(func() {
		size := s.textCaption()
		ui.Text(c, group.name).Bold().FontSize(size).LetterSpacing(size*pane.tracking).TextColor(s.palette.Rail).Margin(0, 0, pane.nameGap, 0)
		ui.Text(c, group.text).Wrap().LineHeight(pane.lineHeight).TextColor(s.palette.Muted).FontSize(s.textSmall()).Margin(0, 0, pane.captionGap, 0)
		for _, row := range group.rows {
			s.drawSettingsRow(c, row, pane)
		}
	})
}

func (s *Shell) drawSettingsRow(c *ui.Context, row settingsRow, pane settingsPane) {
	if row.side {
		s.drawSideRow(c, row, pane)
		return
	}
	if len(row.controls) > 0 && row.controls[0].kind == controlSwatch {
		// .th-grid: as many columns of the least width as the pane holds, which share the free width.
		ui.Grid(c).ColumnTracks(ui.Fr(1).Min(pane.swatchMinW).AutoFill()).FillWidth().Gap(pane.gridGap).Margin(0, 0, pane.gridMargin, 0).Children(func() {
			for _, control := range row.controls {
				s.drawControl(c, control, pane)
			}
		})
		return
	}
	if len(row.controls) > 0 && row.controls[0].kind == controlCaption {
		// A row with a caption is a column: the caption line, then its buttons in a wrapping line (docs/spec/settings.md#plugins).
		ui.Column(c).FillWidth().Gap(pane.nameGap).Children(func() {
			s.drawControl(c, row.controls[0], pane)
			if len(row.controls) > 1 {
				ui.Row(c).FillWidth().Wrap().Gap(pane.nameGap).AlignItems(ui.Center).Children(func() {
					for _, control := range row.controls[1:] {
						s.drawControl(c, control, pane)
					}
				})
			}
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
	marked := slices.ContainsFunc(row.controls, func(control *SettingsControl) bool {
		return strings.HasPrefix(control.item(), "reset:") || control.kind == controlMark
	})
	// A row of the Installed page is the element core.settings-tab.plugin-row with the plugin id as its item.
	// The group role and the label keep the row in the element tree; an unlabelled container is not kept.
	line := ui.Row(c).FillWidth().MinHeight(pane.rowH).Gap(pane.rowGap).AlignItems(ui.Center)
	if row.plugin != "" {
		line = ui.Row(s.binder.Name(c, "core.settings-tab.plugin-row", row.plugin)).Role(ui.RoleGroup).Label(row.name).FillWidth().MinHeight(pane.rowH).Gap(pane.rowGap).AlignItems(ui.Center)
	}
	if marked {
		line.Wrap()
	}
	if row.indent {
		// A dependent row is indented at its start; its control area keeps the end of the row.
		line.Padding(0, 0, 0, pane.indent)
	}
	line.Children(func() {
		s.drawLabelArea(c, row.name, row.description, row.aboutLines, pane)
		// The control area is 260 points at the end of the row, so the controls of every row start at the same x and end at its end. A
		// disabled row takes no press in its control area. The reset marks of the project scope wrap inside it, so each mark stays inside
		// the window.
		area := ui.Row(c).Width(pane.controlW).Shrink(0).Gap(pane.rowGap).AlignItems(ui.Center).Justify(ui.End).Disabled(row.disabled)
		if marked {
			area.Wrap()
		}
		area.Children(func() {
			for _, control := range row.controls {
				s.drawControl(c, control, pane)
			}
		})
	})
}

// drawSideRow draws a row of the sidebar list (docs/spec/settings.md#pages) as the web grid of .set-side: the number, the name
// that fills the row, the badges of the side, then the set select sized to its widest option, the switch and the order buttons, with a
// gap of space-2 between the columns. The list has no 260-point control column.
func (s *Shell) drawSideRow(c *ui.Context, row settingsRow, pane settingsPane) {
	ui.Row(c).FillWidth().MinHeight(pane.rowH).Gap(pane.rowGap).AlignItems(ui.Center).Children(func() {
		ui.Text(c, row.number).FontSize(s.textControl()).TextColor(s.palette.Muted)
		ui.Row(c).Grow(1).Basis(0).MinWidth(0).Gap(pane.nameGap).AlignItems(ui.Center).Children(func() {
			ui.Text(c, row.name).FontSize(s.textControl()).TextColor(s.palette.Fg)
			for _, control := range row.controls {
				if control.kind == controlBadge || control.kind == controlMark {
					s.drawControl(c, control, pane)
				}
			}
		})
		for _, control := range row.controls {
			if control.kind == controlBadge || control.kind == controlMark {
				continue
			}
			wrap := ui.Row(c).Disabled(control.Disabled).Shrink(0)
			wrap.Children(func() {
				if control.kind == controlSelect {
					s.drawSelect(c, control, pane, s.sideSelectWidth(c, control, pane))
					return
				}
				s.drawControl(c, control, pane)
			})
		}
	})
}

// sideSelectWidth is the width of the set select of a side: the width of its widest option with the padding and the arrow, as a native
// select sizes to its longest option (docs/spec/settings.md#pages).
func (s *Shell) sideSelectWidth(c *ui.Context, control *SettingsControl, pane settingsPane) float32 {
	var widest float32
	for _, id := range control.Options {
		widest = max(widest, spanWidth(c, ui.Span{Text: control.labels[id], Size: s.textControl(), Font: s.fontFamily()}))
	}
	arrow := spanWidth(c, ui.Span{Text: "▾", Size: s.textCaption(), Font: s.fontFamily()})
	return widest + pane.fieldPadX + pane.arrowInset + arrow + 2*s.palette.BorderWidth
}

// drawLabelArea draws the label area of a row, which takes the width that the control area leaves: the name, and under it the
// description of the row (docs/spec/settings.md#rows). A row without a label keeps the area empty.
func (s *Shell) drawLabelArea(c *ui.Context, name, description string, aboutLines bool, pane settingsPane) {
	if name == "" && description == "" {
		ui.Box(c).Grow(1).Basis(0)
		return
	}
	ui.Column(c).Grow(1).Basis(0).Gap(pane.nameGap).Children(func() {
		if name != "" {
			// .set-row__name: one line that ends with an ellipsis, so a long label does not grow the row.
			ui.Text(c, name).SingleLine().Ellipsis("…").MinWidth(0).FontSize(s.textControl()).TextColor(s.palette.Muted)
		}
		if aboutLines {
			// Each line is a named element; the item is the line number, so the lines of one plugin page stay apart.
			for index, line := range strings.Split(description, "\n") {
				if line == "" {
					continue
				}
				ui.Text(s.binder.Name(c, "core.settings-tab.plugins.about", fmt.Sprint(index)), line).Wrap().FontSize(s.textSmall()).TextColor(s.palette.Muted)
			}
		} else if description != "" {
			ui.Text(c, description).Wrap().FontSize(s.textSmall()).TextColor(s.palette.Muted)
		}
	})
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
		s.drawSelect(c, control, pane, 0)
	case controlSegment:
		s.drawSegment(c, control, pane)
	case controlSlider:
		s.drawSlider(c, control, pane)
	case controlStepper:
		s.drawStepper(c, control, pane)
	case controlText:
		s.drawTextControl(c, control)
	case controlCaption:
		// A caption without an element name is a plain box: the spec names no element for it (docs/spec/settings.md#controls).
		box := ui.Box(c)
		if control.Name != "" {
			box = s.exposedBox(c, control.Name, "", control.item())
		}
		box.Grow(1).Basis(0).Role(ui.RoleGroup).Label(control.Label).Children(func() {
			ui.Text(c, control.Label).Wrap().FontSize(s.textSmall()).TextColor(s.palette.Muted)
		})
	case controlSetup:
		s.drawSetupRow(c, control, pane)
	case controlAccount:
		s.drawAccountRow(c, control, pane)
	case controlChip:
		// The chip of a section: its name in a box of the card edge (docs/spec/settings.md#pages). A section of a plugin that is
		// not loaded has a dashed edge in the muted tone and its name struck through, with the tooltip that names the plugin.
		chip := s.exposedBox(c, control.Name, "", control.item()).Shrink(0).Padding(0, pane.fieldPadX).BorderWidth(s.palette.BorderWidth).BorderColor(s.palette.Edge).
			Radius(s.radiusSmall()).Role(ui.RoleGroup).Label(control.Label)
		if control.missingTip != "" {
			chip.BorderColor(s.palette.Muted).BorderStyle(ui.BorderDashed).Tooltip(control.missingTip)
		}
		chip.Children(func() {
			name := ui.Text(c, control.Label).NoWrap().FontSize(s.textCaption()).TextColor(s.palette.Fg)
			if control.missingTip != "" {
				name.Strikethrough().TextColor(s.palette.Muted)
			}
		})
	case controlBadge:
		// A badge of a row: ok and acc take the rail token, warn the focus token, err the no token and neutral the muted token (docs/spec/settings.md#controls).
		color := s.badgeColor(control.tone)
		s.exposedBox(c, control.Name, "", control.item()).Shrink(0).Role(ui.RoleGroup).Label(control.Label).Children(func() {
			if control.Icon == "" {
				ui.Text(c, control.Label).NoWrap().FontSize(s.textCaption()).TextColor(color)
				return
			}
			// The badge icon is 16 of the 11 points of the caption, and the gap 4 of them, as the badges of the design (docs/spec/settings.md#controls).
			paint := `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`
			ui.Row(c).AlignItems(ui.Center).Gap(s.textCaption() * 4 / 11).Children(func() {
				ui.Icon(c, s.declaredIcon("0 0 16 16", paint, s.options.Declared.Icons[control.Icon])).Size(s.textCaption()*16/11, s.textCaption()*16/11).Shrink(0).TextColor(color)
				ui.Text(c, control.Label).NoWrap().FontSize(s.textCaption()).TextColor(color)
			})
		})
	case controlMark:
		// The mark that the project value applies, the .set-applied of packages/workbench/app.css (docs/spec/settings.md#scope-of-a-control).
		s.exposedBox(c, control.Name, "", control.item()).Shrink(0).Role(ui.RoleGroup).Label(control.Label).Children(func() {
			ui.Text(c, control.Label).NoWrap().FontSize(s.textCaption()).TextColor(s.palette.Focus)
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
	if control.Primary {
		edge = s.palette.Rail
		fill = faded(s.palette.Rail, s.metrics.chipOnMix)
	}
	button.Padding(pane.fieldPadY, pane.buttonPadX).Border(s.palette.BorderWidth, edge).Radius(s.radiusSmall()).Background(fill).AlignItems(ui.Center).Label(control.Label)
	if control.small {
		button.Height(pane.buttonSmH)
	}
	if control.title != "" {
		// The title of the button shows as its tip, as the title attribute of the button does (docs/spec/settings.md#pages).
		button.Tooltip(control.title)
	}
	button.Children(func() {
		ui.Text(c, control.Label).FontSize(s.textControl()).TextColor(s.palette.Fg)
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
	// The box is small, so the gap is quartered, and a theme without a gap keeps the line that its cards share.
	gap := shape("gap")
	slit, between := float32(max(2, math.Round(gap/4))), ui.Hex(colors["bg"])
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
	button.Column().Gap(pane.swatchGap).Padding(pane.swatchPad).Border(s.palette.BorderWidth, frame).Radius(s.radiusSmall()).Label(control.Label).Children(func() {
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

func (s *Shell) drawSelect(c *ui.Context, control *SettingsControl, pane settingsPane, width float32) {
	// A select of a plugin setting has no value while nothing is chosen, and then it shows no option.
	value := ""
	if control.Value != nil {
		value = *control.Value
	}
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
	// .select-field select:focus-visible: the focus color on the border, without an outline. The select has the width of its column
	// and no minimum (min-width:0), so the label of a long choice is cut at its end and does not widen it.
	trigger := selector.Trigger.FocusRing(false).Clip().Row().Height(pane.fieldH).Padding(pane.fieldPadY, pane.arrowInset, pane.fieldPadY, pane.fieldPadX).Radius(s.radiusSmall()).Border(s.palette.BorderWidth, edge).Background(s.palette.Bg).AlignItems(ui.Center).Label(control.Label)
	// A side select has the width of its widest option; the select of a setting fills its column and cuts a long label at its end.
	if width > 0 {
		trigger.Width(width).Shrink(0)
	} else {
		trigger.Grow(1).Shrink(1).MinWidth(0)
	}
	trigger.Children(func() {
		ui.Text(c, control.labels[value]).FontSize(s.textControl()).TextColor(s.palette.Fg).NoWrap().Grow(1).Shrink(1).MinWidth(0)
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

// sliderDrag is a slider of the settings that the pointer drags: the item of its control and the value that the drag reached.
type sliderDrag struct {
	item  string
	value float64
}

// drawSlider draws a bounded number, the .set-slide of packages/workbench/app.css. A drag shows each value beside the slider and runs
// the command once, with the value at the release, as the page reports a range only on change; a key runs it for each step.
func (s *Shell) drawSlider(c *ui.Context, control *SettingsControl, pane settingsPane) {
	value, err := strconv.ParseFloat(*control.Value, 64)
	if err != nil {
		s.fail(fmt.Errorf("the setting %s is not a number: %s", control.item(), *control.Value))
		return
	}
	drag := s.sliderDrag
	if drag != nil && drag.item != control.item() {
		drag = nil
	}
	if drag != nil {
		value = drag.value
	}
	ui.Row(c).Grow(1).Gap(pane.slideGap).AlignItems(ui.Center).Children(func() {
		s.binder.Control(c, control.Name, control.Command.Name, control.item())
		// The slider of the page is as tall as its track, and takes the pointer over the thumb that stands out of it.
		reach := (pane.thumb - pane.trackH) / 2
		slider := s.binder.Bound(ui.SliderBase(c, &value, control.lo, control.hi), control.Name).Label(control.item()).Grow(1).Height(pane.trackH).
			HitOutset(reach).PaddingX(pane.thumb / 2)
		switch {
		case slider.Pressed():
			if slider.Changed() || drag == nil {
				s.sliderDrag = &sliderDrag{item: control.item(), value: math.Round(value)}
			}
		case drag != nil:
			s.sliderDrag = nil
			if !slider.PressCanceled() && valueText(drag.value) != *control.Value {
				s.runControl(control, drag.value)
			}
		case slider.Changed():
			s.runControl(control, math.Round(value))
		}
		shown := *control.Value
		if drag := s.sliderDrag; drag != nil && drag.item == control.item() {
			shown = valueText(drag.value)
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
		ui.Text(c, shown+control.unit).Width(s.chLength(c, "slide-value-w", s.textSmall())).TextAlign(ui.End).FontSize(s.textSmall()).TextColor(s.palette.Muted)
	})
}

// drawSegment draws a segment of two or three listed values: one button per value in the declared order, the current value pressed. Each
// button runs the setting command with its value.
func (s *Shell) drawSegment(c *ui.Context, control *SettingsControl, pane settingsPane) {
	s.binder.Control(c, control.Name, control.Command.Name, control.item())
	ui.Row(c).Shrink(0).Gap(pane.segGap).Padding(pane.segPad).AlignItems(ui.Center).Border(s.palette.BorderWidth, s.palette.Edge).Radius(s.radiusSmall()).Background(s.palette.Bg).Children(func() {
		for _, value := range control.Options {
			params := make(map[string]any, len(control.Command.Params)+1)
			for key, param := range control.Command.Params {
				params[key] = param
			}
			if control.param != "" {
				params[control.param] = value
			}
			button := s.binder.Press(c, control.Name, control.Command.Name, control.item()+":"+value, params)
			on := value == *control.Value
			color := s.palette.Muted
			if on {
				color = s.palette.Fg
				button.Background(faded(s.palette.Fg, s.metrics.chipSelMix))
			} else if button.Hovered() {
				color = s.palette.Fg
			}
			label := control.labels[value]
			button.Padding(pane.segButtonPadY, pane.segButtonPadX).Radius(s.radiusSmall()).AlignItems(ui.Center).Label(label).Children(func() {
				ui.Text(c, label).NoWrap().FontSize(s.textSmall()).TextColor(color)
			})
		}
	})
}

// drawStepper draws a stepper, the segment − value unit +: each button runs the setting command with the value one step lower or
// higher, held within the bounds of the setting (docs/spec/settings.md#controls).
func (s *Shell) drawStepper(c *ui.Context, control *SettingsControl, pane settingsPane) {
	value, err := strconv.ParseFloat(*control.Value, 64)
	if err != nil {
		s.fail(fmt.Errorf("the setting %s is not a number: %s", control.item(), *control.Value))
		return
	}
	s.binder.Control(c, control.Name, control.Command.Name, control.item())
	ui.Row(c).Shrink(0).Gap(pane.segGap).Padding(pane.segPad).AlignItems(ui.Center).Border(s.palette.BorderWidth, s.palette.Edge).Radius(s.radiusSmall()).Background(s.palette.Bg).Children(func() {
		s.drawStepButton(c, control, "−", "down", math.Max(control.lo, value-1), pane)
		ui.Text(c, *control.Value+" "+control.unit).NoWrap().FontSize(s.textSmall()).TextColor(s.palette.Fg)
		s.drawStepButton(c, control, "+", "up", math.Min(control.hi, value+1), pane)
	})
}

// drawStepButton draws one button of a stepper; its item is the setting key and the direction, and it runs the setting command with next.
func (s *Shell) drawStepButton(c *ui.Context, control *SettingsControl, mark, direction string, next float64, pane settingsPane) {
	params := make(map[string]any, len(control.Command.Params)+1)
	for key, param := range control.Command.Params {
		params[key] = param
	}
	if control.param != "" {
		params[control.param] = next
	}
	button := s.binder.Press(c, control.Name, control.Command.Name, control.item()+":"+direction, params)
	color := s.palette.Muted
	if button.Hovered() {
		color = s.palette.Fg
	}
	button.Padding(pane.segButtonPadY, pane.segButtonPadX).Radius(s.radiusSmall()).AlignItems(ui.Center).Label(mark).Children(func() {
		ui.Text(c, mark).NoWrap().FontSize(s.textSmall()).TextColor(color)
	})
}

// drawTextControl draws a one-line field. A setting takes its text when the field submits or loses the focus, as the change
// of an input does, and the search takes each change.
func (s *Shell) drawTextControl(c *ui.Context, control *SettingsControl) {
	w := &s.settingsTab
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
	field := s.plainControls().field(c, s.binder.Bound(ui.TextInputBase(c, &value), control.Name)).Label(key).Placeholder(control.Label).Grow(1).Height(s.readSettingsPane().fieldH)
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
		// The browser empties a search on Escape as its cancel does, and the cancel keeps the focus in the field. An empty search leaves
		// the key to the window.
		if value != "" {
			if plain.drawSearchCancel(c) {
				field.Focus()
				s.runControl(control, "")
			} else if field.Shortcut(0, ui.KeyEscape) {
				s.runControl(control, "")
			}
		}
	})
}

// drawSetupRow draws the name, state, file and optional action of a setup part. The error of a part shows in the error toast.
func (s *Shell) drawSetupRow(c *ui.Context, control *SettingsControl, pane settingsPane) {
	row := control.setup
	s.exposedBox(c, control.Name, "", control.item()).FillWidth().Row().MinHeight(pane.rowH).Gap(pane.rowGap).AlignItems(ui.Center).Role(ui.RoleGroup).Label(control.Label).Children(func() {
		s.drawLabelArea(c, row.name, "", false, pane)
		// The state, the file and the action are in the control area, which starts at the same x as the controls of every row.
		ui.Row(c).Width(pane.controlW).Shrink(0).Gap(pane.rowGap).AlignItems(ui.Center).Children(func() {
			ui.Column(c).Grow(1).Basis(0).Gap(pane.captionGap).Children(func() {
				// A failed part keeps a state label; the error text shows in the error toast.
				if row.failed {
					ui.Text(c, "오류").Wrap().FontSize(s.textControl()).TextColor(s.palette.Muted)
				} else {
					ui.Text(c, row.state).Wrap().FontSize(s.textControl()).TextColor(s.palette.Fg)
				}
				ui.Text(c, row.file).Wrap().FontSize(s.textSmall()).TextColor(s.palette.Muted)
			})
			if row.action != nil {
				s.drawButton(c, row.action, pane)
			}
		})
	})
}

// drawAccountRow draws a row of the group Accounts: the line of the account, its usage lines, and its controls in one line.
func (s *Shell) drawAccountRow(c *ui.Context, control *SettingsControl, pane settingsPane) {
	row := control.account
	s.exposedBox(c, control.Name, "", control.item()).FillWidth().Column().Gap(pane.rowGap).Role(ui.RoleGroup).Label(control.Label).Children(func() {
		ui.Text(c, row.line).Wrap().FontSize(s.textControl()).TextColor(s.palette.Fg)
		for _, line := range row.usage {
			ui.Text(c, line).Wrap().FontSize(s.textSmall()).TextColor(s.palette.Muted)
		}
		ui.Row(c).FillWidth().Wrap().Gap(pane.nameGap).AlignItems(ui.Center).Children(func() {
			for _, item := range row.controls {
				s.drawControl(c, item, pane)
			}
		})
	})
}

// badgeColor returns the theme token of a badge tone; an unknown tone is rejected by the caller that builds the badge.
func (s *Shell) badgeColor(tone string) ui.Color {
	switch tone {
	case "ok", "acc":
		return s.palette.Rail
	case "warn":
		return s.palette.Focus
	case "err":
		return s.palette.No
	}
	return s.palette.Muted
}
