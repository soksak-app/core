package workbench

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The chrome bar and the tabs of the spaces. The buttons, their order and their commands are those of packages/workbench/index.html
// and projects.js.

// drawChrome draws the chrome bar of the window, a band of the card color with its edge under it: the logo, the tabs of the projects and the
// switches. The project home has no layout, so its bar leaves out the project list and the balance.
func (s *Shell) drawChrome(c *ui.Context, width float32) {
	browsing := s.browsing || s.opened() == nil
	ui.Row(s.binder.Name(c, "core.chrome.bar", "")).Size(width, s.chromeHeight()).Padding(0, s.metrics.spacePad, 0, s.metrics.spacePad+s.controlsWidth).AlignItems(ui.Center).Gap(s.metrics.chromeGap).
		Background(s.palette.Card).BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Edge).DragWindow().
		ObserveInput(s.placeInput(FrameScope())).Role(ui.RoleGroup).Label("core.chrome.bar").Children(func() {
		s.drawBrand(c)
		ui.Row(c).Grow(1).MinWidth(0).Clip().AlignItems(ui.Center).Gap(s.frameLength(s.metrics.tabsGap)).Children(func() {
			if !browsing && s.projectTabsPlace() == "top" {
				for _, project := range s.projects {
					s.drawBarTab(c, s.projectTab(c, project))
				}
				s.drawBarAdd(c, s.binder.Press(c, "core.project-tab.add", "core.projects.browse", "", nil))
			}
		})
		s.drawSettingsChip(c)
		ui.Row(c).Shrink(0).AlignItems(ui.Center).Gap(s.frameLength(s.metrics.chromeActsGap)).Children(func() { s.drawChromeActs(c, browsing) })
	})
}

// keepControls takes the area of the window buttons that the host answered with windowControls or with the chrome of a
// preparation, and keeps its end x + w as the width that the first row leaves to the buttons, as applyControls of
// packages/workbench/index.html sets --controls-w. An answer without buttons (w 0) sets nothing, so the row keeps the width of
// the last answer with buttons, and 0 before any.
func (s *Shell) keepControls(at layout.Rect) {
	s.surfaces.controls = &at
	if at.W > 0 {
		s.controlsWidth = float32(at.X + at.W)
	}
}

// drawBrand draws the logo of the workbench, the element core.chrome.projects, the first element of the title bar. A press on it runs
// core.projects.browse (docs/spec/external-sidebars.md#window-tools).
func (s *Shell) drawBrand(c *ui.Context) {
	box := s.options.Declared.ChromeValue("brand-logo-box")
	var left, top, wide, high float32
	if _, err := fmt.Sscanf(box, "%g %g %g %g", &left, &top, &wide, &high); err != nil {
		s.fail(fmt.Errorf("the chrome value brand-logo-box %q: %w", box, err))
		return
	}
	mode := "brand-text-dark"
	if s.settings.Value("mode") == "light" {
		mode = "brand-text-light"
	}
	text := s.options.Declared.ChromeValue(mode)
	height := s.frameLength(float32(s.settings.Value("size").(float64)) * s.metrics.brandLogoAtBase / s.metrics.textBase)
	s.binder.Press(c, "core.chrome.projects", "core.projects.browse", "", nil).Shrink(0).MarginEnd(s.frameLength(s.metrics.brandGap)).Role(ui.RoleButton).Label("soksak").Children(func() {
		// An icon takes one color, and the tile of the logo keeps its own, so the logo is an image with its letters in the color of the mode.
		ui.Image(c, s.declaredIcon(box, "", strings.ReplaceAll(s.options.Declared.Icons["brand-logo"], "currentColor", text))).Size(height*wide/high, height)
	})
}

// settingChange is the parameter of core.settings.change that writes a value of a side switch to its scope
// (docs/spec/settings.md#scope-of-a-control).
type settingChange struct {
	Key   string `json:"key"`
	Value bool   `json:"value"`
	Scope string `json:"scope"`
}

// drawChromeActs draws the window tools of the title bar for the screen in front (docs/spec/external-sidebars.md#window-tools): on the
// work screen the four side switches, a separator and the settings button; on the project home only the settings button. The settings
// tab shows none.
func (s *Shell) drawChromeActs(c *ui.Context, browsing bool) {
	// The settings tab in front shows no tool, and its settings entry is the chip beside the project tabs. The bell is drawn on every screen.
	if s.settingsTabInFront() {
		s.drawBell(c)
		return
	}
	if !browsing {
		// The switch of each side shows or hides its window sidebar, in the order left, right, top, bottom. It shows the applied value of
		// its side and writes the negated value to the scope that the applied value comes from.
		for _, side := range layout.WindowSides {
			on, _ := s.settings.Value(side).(bool) // silent: the settings store checks the type of the value.
			s.chromeAct(c, "core.chrome."+side, "core.settings.change", sideNames[side]+" 사이드바 보이기", "panel-"+side, on,
				settingChange{Key: side, Value: !on, Scope: s.settings.Source(side)})
		}
		ui.Box(c).Size(s.frameLength(1), s.frameLength(s.metrics.actH)).Shrink(0).Background(s.palette.Edge)
	}
	s.chromeAct(c, "core.chrome.settings", "core.settings.open", "설정", "settings", false, nil)
	// The bell is the last element of the title bar, after the tools of the screen (docs/spec/notifications.md#bell).
	s.drawBell(c)
}

// drawSettingsChip draws the chip of the settings tab beside the project tabs while the window has a settings tab
// (docs/spec/settings.md#opening-and-closing). The chip runs core.settings.open, which brings the tab to the front, and its close
// control runs core.settings.close. The chip has the rail border while the tab is in front.
func (s *Shell) drawSettingsChip(c *ui.Context) {
	if !s.settingsTab.open {
		return
	}
	m := s.metrics
	border := s.palette.Edge
	if s.settingsTabInFront() {
		border = s.palette.Rail
	}
	size := s.frameFont(s.textControl())
	ui.Row(c).Shrink(0).AlignItems(ui.Center).Gap(s.frameLength(m.chromeGap)).Margin(0, 0, 0, s.frameLength(m.chromeGap)).Children(func() {
		open := s.binder.Press(c, "core.settings-tab.chip", "core.settings.open", "", nil)
		open.Height(s.frameLength(m.spaceTabH)).PaddingX(s.frameLength(m.chromeGap)).AlignItems(ui.Center).Radius(s.radiusSmall()).
			Gap(s.frameLength(m.chromeGap)).Border(s.palette.BorderWidth, border).Label("설정").Children(func() {
			// The gear is the settings icon of the title bar gear, at its size and stroke.
			icon := s.frameLength(m.actIcon)
			paint := fmt.Sprintf(`fill="none" stroke="currentColor" stroke-width="%g"`, m.actStroke)
			ui.Icon(c, s.declaredIcon("0 0 24 24", paint, s.options.Declared.Icons["settings"])).Size(icon, icon).TextColor(s.palette.Fg)
			ui.Text(c, "설정").SingleLine().FontSize(size).TextColor(s.palette.Fg)
		})
		closing := s.binder.Press(c, "core.settings-tab.close", "core.settings.close", "", nil)
		closing.Height(s.frameLength(m.spaceTabH)).PaddingX(s.frameLength(m.barXPad)).AlignItems(ui.Center).Label("설정 탭 닫기").Tooltip("설정 탭 닫기")
		closing.Children(func() {
			ui.Text(c, "×").SingleLine().FontSize(size).TextColor(s.palette.Muted)
		})
	})
}

// appliedPatch is the parameter of core.settings.set that writes value of key to the scope that the applied value of key comes
// from (docs/spec/settings.md#scope-of-a-control).
func (s *Shell) appliedPatch(key string, value any) settingsPatchParam {
	return settingsPatchParam{Patch: map[string]any{key: value}, Scope: s.settings.Source(key)}
}

// chromeAct draws an icon switch of the chrome bar, the .act of packages/workbench/app.css.
func (s *Shell) chromeAct(c *ui.Context, name, command, title, icon string, on bool, params any) {
	s.drawAct(c, s.binder.Press(c, name, command, "", params), title, icon, on, float32(s.text.Frame()))
}

// drawAct draws an icon switch, the .act of packages/workbench/app.css, with its lengths at scale.
func (s *Shell) drawAct(c *ui.Context, button ui.Element, title, icon string, on bool, scale float32, badges ...func()) {
	m := s.metrics
	button.Size(scale*m.actW, scale*m.actH).Shrink(0).Center().Radius(s.radiusSmall()).Label(title).Tooltip(title)
	color := s.palette.Muted
	if button.Hovered() {
		color = s.palette.Fg
		button.Background(faded(s.palette.Fg, m.insetMix))
	}
	if on {
		color = s.palette.Focus
	}
	paint := fmt.Sprintf(`fill="none" stroke="currentColor" stroke-width="%g"`, m.actStroke)
	button.Children(func() {
		size := scale * m.actIcon
		ui.Icon(c, s.declaredIcon("0 0 24 24", paint, s.options.Declared.Icons[icon])).Size(size, size).TextColor(color)
		for _, badge := range badges {
			badge()
		}
	})
}

// chromeTextAct draws a switch of the chrome bar that shows a text, the .act--text of packages/workbench/app.css.
func (s *Shell) chromeTextAct(c *ui.Context, name, command, title string) {
	m := s.metrics
	button := s.binder.Press(c, name, command, "", nil)
	button.Height(s.frameLength(m.actH)).Shrink(0).PaddingX(s.frameLength(m.chromeGap)).AlignItems(ui.Center).Radius(s.radiusSmall()).Label(title)
	color := s.palette.Muted
	if button.Hovered() {
		color = s.palette.Fg
		button.Background(faded(s.palette.Fg, m.insetMix))
	}
	button.Children(func() {
		ui.Text(c, title).SingleLine().FontSize(s.frameFont(s.textControl())).TextColor(color)
	})
}

// barTab is a tab of a bar, the .bar-tab of packages/workbench/app.css: a chip that holds its name and its close button. The chip of the selected tab
// takes the rail color, or tint when the tab has a color of its own.
type barTab struct {
	key, title string
	on         bool
	tint       string
	rename     renameTarget
	radius     [4]float32
	pick       func() ui.Element
	close      func() ui.Element
	// drag is the value that the tab drags, and drop takes a value dropped on it, for a tab that can change places.
	drag any
	drop func(chip ui.Element)
	// activity is the activity of the project or the space id of the tab, "" for none, and activityName the element name of its icon.
	id, activity, activityName string
	// project marks the tab of a project, which is the project chip of the top bar: its height and padding are the declared project chip values.
	project bool
}

// barTabColors returns the text color and the fill of a tab.
func (s *Shell) barTabColors(tab barTab, hovered bool) (ui.Color, ui.Color) {
	m := s.metrics
	if tab.on {
		if tab.tint != "" {
			return s.palette.Fg, faded(ui.Hex(tab.tint), m.projectTabMix)
		}
		return s.palette.Fg, faded(s.palette.Rail, m.chipOnMix)
	}
	if hovered {
		return s.palette.Muted, faded(s.palette.Fg, m.chipHoverMix)
	}
	return s.palette.Muted, faded(s.palette.Fg, m.chipMix)
}

// renameOnDoubleClick begins the rename of a tab when the release of a double click lands on it, as dblclick of a page follows that
// release. The second press stays on the tab until then, and a press that leaves the tab begins nothing.
func (s *Shell) renameOnDoubleClick(name ui.Element, target renameTarget) {
	doubled := name.DoubleClicked()
	if doubled {
		s.doublePressed = target
	}
	clicked := name.Clicked()
	switch {
	case s.doublePressed != target:
	case clicked:
		s.doublePressed = renameTarget{}
		s.binder.run("core.rename.begin", target)
	case !name.Pressed():
		s.doublePressed = renameTarget{}
	}
}

func (s *Shell) drawBarTab(c *ui.Context, tab barTab) {
	if s.renaming != nil && s.renaming.renameTarget == tab.rename {
		s.drawRenameField(c, s.frameLength(s.metrics.barTabRootW), s.frameFont(s.textControl()))
		return
	}
	m := s.metrics
	size := s.frameFont(s.textControl())
	pad := s.frameLength(m.chromeGap)
	line := lineBox(size, m.lineHeight)
	high := s.frameLength(m.spaceTabH)
	if tab.project {
		high, pad = s.frameLength(m.projectChipH), s.frameLength(m.projectChipPad)
	}
	holder := ui.Box(c.Key(tab.key)).Shrink(0)
	color, fill := s.barTabColors(tab, holder.Hovered())
	holder.Children(func() {
		// The whole chip is the button, so a press above its name shows its project or space. A control does not hold a control, so the
		// close button stands over the room that the chip keeps for it.
		chip := tab.pick().Height(high).AlignItems(ui.Center).Radius(tab.radius[0], tab.radius[1], tab.radius[2], tab.radius[3]).
			Label(tab.title).Tooltip(tab.title).Background(fill)
		s.renameOnDoubleClick(chip, tab.rename)
		if tab.drag != nil {
			chip.Drag(tab.drag)
		}
		if tab.drop != nil {
			tab.drop(chip)
		}
		room := pad
		if tab.close != nil {
			mark := spanWidth(c, ui.Span{Text: tabCloseMark, Size: size, Font: s.fontFamily()})
			room = s.frameLength(m.barGap) + mark + 2*s.frameLength(m.barXPad) + pad
		}
		// The icon of the activity of the project or the space stands before the name, over the room that the chip keeps for it
		// (docs/spec/activity.md#drawing).
		icon, gap := s.activityMark(size)
		start := pad
		if tab.activity != "" {
			start += icon + gap
		}
		chip.Children(func() {
			ui.Row(c).Padding(0, room, 0, start).Children(func() {
				ui.Text(c, tab.title).SingleLine().Ellipsis("…").FontSize(size).MaxWidth(s.frameLength(m.barTabMaxW)).TextColor(color)
			})
		})
		if tab.activity != "" {
			ui.Box(c).Absolute().Left(pad).Top((high - icon) / 2).Children(func() { s.drawActivity(c, tab.activityName, tab.id, tab.activity, icon) })
		}
		if tab.close == nil {
			return
		}
		closing := tab.close()
		closing.Absolute().Top((high - line) / 2).Right(pad).Height(line).PaddingX(s.frameLength(m.barXPad)).AlignItems(ui.Center).Label("닫기").Tooltip("닫기")
		if !closing.Hovered() {
			closing.Opacity(m.barXOpacity)
		}
		closing.Children(func() {
			ui.Text(c, tabCloseMark).SingleLine().FontSize(size).TextColor(color)
		})
	})
}

// drawBarAdd draws the button that adds a tab of a bar, which has no chip until the pointer stands on it.
func (s *Shell) drawBarAdd(c *ui.Context, button ui.Element) {
	m := s.metrics
	button.Height(s.frameLength(m.spaceTabH)).PaddingX(s.frameLength(m.barAddPad)).Radius(s.radiusSmall()).AlignItems(ui.Center).Label("+").Children(func() {
		ui.Text(c, "+").SingleLine().FontSize(s.frameFont(m.barAddText)).TextColor(s.palette.Muted)
	})
	if button.Hovered() {
		button.Background(faded(s.palette.Fg, m.chipHoverMix))
	}
}

// projectTabDrag is the value that a project tab drags.
type projectTabDrag struct{ id string }

// projectTab describes the tab of a project. The tab of the shown project has the color of the project.
func (s *Shell) projectTab(c *ui.Context, project projectRecord) barTab {
	radius := s.radiusSmall()
	// silent: shownActivities gives the activities of the tabs, the group cards, the projects and the spaces; a project tab reads only those of the projects.
	_, _, activities, _ := s.shownActivities()
	return barTab{key: "project-" + project.ID, title: project.Title, on: project.ID == s.active, tint: project.Color, rename: renameTarget{"project", project.ID}, project: true,
		id: project.ID, activity: activities[project.ID], activityName: "core.activity.project",
		radius: [4]float32{radius, radius, radius, radius}, drag: projectTabDrag{project.ID},
		drop: func(chip ui.Element) {
			if held, ok := ui.Drop[projectTabDrag](chip); ok {
				s.dropProjectTab(held.id, project.ID)
			}
		},
		pick: func() ui.Element {
			return s.binder.Press(c, "core.project-tab", "core.project.activate", project.ID, idParam{project.ID})
		},
		close: func() ui.Element {
			return s.binder.Press(c, "core.project-tab.close", "core.project.close", project.ID, idParam{project.ID})
		}}
}

// dropProjectTab moves the project of a dragged tab to the place of the tab that it was dropped on.
func (s *Shell) dropProjectTab(dragged, onto string) {
	at := func(id string) int {
		return slices.IndexFunc(s.projects, func(project projectRecord) bool { return project.ID == id })
	}
	if from := at(dragged); from >= 0 {
		s.binder.run("core.project.move", map[string]any{"id": dragged, "delta": at(onto) - from})
	}
}

// projectTabsPlace is the setting of the place of the project tabs.
func (s *Shell) projectTabsPlace() string {
	place, ok := s.settings.Value("projectTabs").(string)
	if !ok {
		s.fail(fmt.Errorf("the setting projectTabs has no text"))
	}
	return place
}

// projectColumnWidth is the width of the column of the project tabs at the left of the work area, and 0 while the window has none there.
func (s *Shell) projectColumnWidth() float32 {
	return s.sideColumnWidth("left")
}

// rightColumnWidth is the width of the column of the project tabs at the right of the work area, and 0 while the window has none there.
func (s *Shell) rightColumnWidth() float32 {
	return s.sideColumnWidth("right")
}

// sideColumnWidth is the width of the column of the project tabs at place left or right, and 0 while the window shows another place or
// the project home.
func (s *Shell) sideColumnWidth(place string) float32 {
	if s.inHome() || s.projectTabsPlace() != place {
		return 0
	}
	return float32(math.Round(float64(s.frameLength(s.metrics.projectColumnW))))
}

// bottomRowHeight is the height of the row of the project tabs under the work area, and 0 while the window has none there: a project tab,
// the padding above and below it, and the border of the top edge (docs/spec/settings.md#values, projectTabs = bottom).
func (s *Shell) bottomRowHeight() float32 {
	if s.inHome() || s.projectTabsPlace() != "bottom" {
		return 0
	}
	return s.frameLength(s.metrics.projectTabH) + 2*s.frameLength(s.metrics.projectColumnPad) + s.palette.BorderWidth
}

// drawWorkArea draws the spaces and the plane of the shown project beside the column of the project tabs at the left or the right, and above
// the row of the project tabs at the bottom. The column runs from under the first row to the status bar; the row runs across the window.
func (s *Shell) drawWorkArea(c *ui.Context, width, height float32) {
	left, right, bottom := s.projectColumnWidth(), s.rightColumnWidth(), s.bottomRowHeight()
	workHeight := height - bottom
	if left == 0 && right == 0 && bottom == 0 {
		s.drawWork(c, width, height)
	} else {
		ui.Column(c).Size(width, height).Children(func() {
			ui.Row(c).Size(width, workHeight).Children(func() {
				if left > 0 {
					s.drawProjectColumn(c, left, workHeight, "left")
				}
				ui.Column(c).Size(width-left-right, workHeight).Children(func() { s.drawWork(c, width-left-right, workHeight) })
				if right > 0 {
					s.drawProjectColumn(c, right, workHeight, "right")
				}
			})
			if bottom > 0 {
				s.drawProjectRow(c, width, bottom)
			}
		})
	}
	// The stage stands below the title bar and the space row, beside the project column. Its edges are drawn over it.
	stageTop := s.chromeHeight() + s.spaceRowHeight()
	s.drawSidebarEdges(c, layout.Rect{X: float64(left), Y: float64(stageTop), W: float64(width - left - right), H: float64(workHeight - s.spaceRowHeight())})
}

// drawSidebarEdges draws the + <side> button at the edge of each hidden side that has a choice, while the pointer is over that edge
// (docs/spec/external-sidebars.md#sidebar-head-and-edge). The edges stand over the stage rectangle stage, in window coordinates.
func (s *Shell) drawSidebarEdges(c *ui.Context, stage layout.Rect) {
	thick := float64(s.frameLength(s.metrics.space4))
	choices := s.sidebars.Sides()
	for _, side := range layout.WindowSides {
		// silent: the settings store checks the type of the value of a side.
		if on, _ := s.settings.Value(side).(bool); on || !slices.Contains(choices, side) {
			continue
		}
		var edge layout.Rect
		switch side {
		case "left":
			edge = layout.Rect{X: stage.X, Y: stage.Y, W: thick, H: stage.H}
		case "right":
			edge = layout.Rect{X: stage.X + stage.W - thick, Y: stage.Y, W: thick, H: stage.H}
		case "top":
			edge = layout.Rect{X: stage.X, Y: stage.Y, W: stage.W, H: thick}
		default:
			edge = layout.Rect{X: stage.X, Y: stage.Y + stage.H - thick, W: stage.W, H: thick}
		}
		box := ui.Column(c).Absolute().Left(float32(edge.X)).Top(float32(edge.Y)).Size(float32(edge.W), float32(edge.H)).Center()
		box.Children(func() {
			if !box.Hovered() {
				s.binder.Absent(c, "core.sidebar.edge", "core.settings.change", side, settingChange{Key: side, Value: true, Scope: s.settings.Source(side)})
				return
			}
			button := s.binder.Press(c, "core.sidebar.edge", "core.settings.change", side, settingChange{Key: side, Value: true, Scope: s.settings.Source(side)})
			button.Border(s.palette.BorderWidth, s.palette.Edge).Radius(s.radiusSmall()).Background(s.palette.Card).PaddingX(s.frameLength(s.metrics.chromeGap))
			button.Children(func() {
				ui.Text(c, "+ "+sideNames[side]).SingleLine().FontSize(s.frameFont(s.textCaption())).TextColor(s.palette.Fg)
			})
		})
	}
}

func (s *Shell) drawProjectColumn(c *ui.Context, width, height float32, place string) {
	m := s.metrics
	pad := s.frameLength(m.projectColumnPad)
	// The border stands on the inner edge of the column: the right edge of the left column and the left edge of the right column.
	inner, outer := s.palette.BorderWidth, float32(0)
	if place == "right" {
		inner, outer = 0, s.palette.BorderWidth
	}
	ui.Column(s.binder.Name(c, "core.projects.column", "")).Role(ui.RoleGroup).Label("프로젝트 탭").Size(width, height).Shrink(0).Clip().Padding(pad).Gap(s.frameLength(m.projectColumnGap)).
		Background(s.palette.Card).BorderWidth(0, inner, 0, outer).BorderColor(s.palette.Edge).ObserveInput(s.placeInput(FrameScope())).Children(func() {
		for _, project := range s.projects {
			s.drawColumnTab(c, s.projectTab(c, project), width-2*pad-s.palette.BorderWidth)
		}
		add := s.binder.Press(c, "core.project-tab.add", "core.projects.browse", "", nil)
		add.FillWidth().Height(s.frameLength(m.projectTabAddH)).Radius(s.radiusSmall()).Center().Label("+").Children(func() {
			ui.Text(c, "+").SingleLine().FontSize(s.frameFont(m.barAddText)).TextColor(s.palette.Muted)
		})
		if add.Hovered() {
			add.Background(faded(s.palette.Fg, m.chipHoverMix))
		}
	})
}

// drawProjectRow draws the row of the project tabs under the work area: the tabs in one line, then the add button, with the border of its top
// edge (docs/spec/settings.md#values, projectTabs = bottom).
func (s *Shell) drawProjectRow(c *ui.Context, width, height float32) {
	pad := s.frameLength(s.metrics.projectColumnPad)
	ui.Row(c).Size(width, height).Padding(pad).Gap(s.frameLength(s.metrics.tabsGap)).AlignItems(ui.Center).Clip().Background(s.palette.Card).
		BorderWidth(s.palette.BorderWidth, 0, 0, 0).BorderColor(s.palette.Edge).Role(ui.RoleGroup).Label("프로젝트 탭").Children(func() {
		for _, project := range s.projects {
			s.drawBarTab(c, s.projectTab(c, project))
		}
		s.drawBarAdd(c, s.binder.Press(c, "core.project-tab.add", "core.projects.browse", "", nil))
	})
}

// drawColumnTab draws a tab of the column. The column is wide enough only for the name, so the close button stands over the name until
// the pointer or the focus is on the tab.
func (s *Shell) drawColumnTab(c *ui.Context, tab barTab, width float32) {
	if s.renaming != nil && s.renaming.renameTarget == tab.rename {
		s.drawRenameField(c, width, s.frameFont(s.textControl()))
		return
	}
	m := s.metrics
	chip := ui.Box(c.Key(tab.key)).FillWidth().Height(s.frameLength(m.projectTabH)).Shrink(0).Radius(s.radiusSmall())
	color, fill := s.barTabColors(tab, chip.Hovered())
	size := s.frameFont(s.textControl())
	inset := s.frameLength(m.projectTabXInset)
	tab.drop(chip)
	chip.Background(fill).Children(func() {
		name := tab.pick()
		s.renameOnDoubleClick(name, tab.rename)
		// The icon of the activity and the name stand centred together: the name is centred in the room after the icon and its gap, and
		// the icon stands before the name over that room (docs/spec/activity.md#drawing).
		pad := s.frameLength(m.projectTabPad)
		icon, gap := s.activityMark(size)
		lead := float32(0)
		if tab.activity != "" {
			lead = icon + gap
		}
		name.Drag(tab.drag).Fill().Padding(0, pad, 0, pad+lead).Center().Label(tab.title).Tooltip(tab.title).Children(func() {
			ui.Text(c, tab.title).SingleLine().Ellipsis("…").FontSize(size).TextColor(color)
		})
		if tab.activity != "" {
			text := min(spanWidth(c, ui.Span{Text: tab.title, Size: size, Font: s.fontFamily()}), width-2*pad-lead)
			ui.Box(c).Absolute().Left((width - lead - text) / 2).Top((s.frameLength(m.projectTabH) - icon) / 2).Children(func() {
				s.drawActivity(c, tab.activityName, tab.id, tab.activity, icon)
			})
		}
		closing := tab.close()
		closing.Absolute().Top(inset).Right(inset).PaddingX(s.frameLength(m.barXPad)).Label("닫기").Tooltip("닫기")
		if !chip.Hovered() && !closing.FocusVisible() {
			closing.Opacity(0)
		}
		closing.Children(func() {
			ui.Text(c, tabCloseMark).SingleLine().FontSize(size).TextColor(color)
		})
	})
}

// drawSpaces draws the row of the spaces of the project, a band of the card color with its edge under it.
func (s *Shell) drawSpaces(c *ui.Context, project *projectRecord, width float32) {
	m := s.metrics
	ui.Row(c).Size(width, s.spaceRowHeight()).Padding(0, s.frameLength(m.spacePad)).AlignItems(ui.Center).Gap(s.frameLength(m.spaceGap)).
		Background(s.palette.Card).BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Edge).ObserveInput(s.placeInput(FrameScope())).Children(func() {
		for _, space := range project.Spaces {
			s.drawSpaceTab(c, project, space)
		}
		s.drawBarAdd(c, s.binder.Press(c, "core.space-tab.add", "core.space.add", "", nil))
	})
}

func (s *Shell) drawSpaceTab(c *ui.Context, project *projectRecord, space layout.Space) {
	radius := s.radiusSmall()
	_, _, _, activities := s.shownActivities()
	tab := barTab{key: "space-" + space.ID, title: space.Title, on: space.ID == project.ActiveSpaceID, rename: renameTarget{"space", space.ID}, radius: [4]float32{radius, radius, 0, 0},
		id: space.ID, activity: activities[space.ID], activityName: "core.activity.space",
		pick: func() ui.Element {
			return s.binder.Press(c, "core.space-tab", "core.space.activate", space.ID, idParam{space.ID})
		}}
	if len(project.Spaces) > 1 {
		tab.close = func() ui.Element {
			return s.binder.Press(c, "core.space-tab.close", "core.space.close", space.ID, idParam{space.ID})
		}
	}
	s.drawBarTab(c, tab)
}

// BalanceIcon is the icon of the card auto-arrange button for the arrangement that its command runs: layout-grid for even, and
// columns-3 for resize (docs/spec/settings.md#controls).
func BalanceIcon(arrange string) string {
	if arrange == "even" {
		return "layout-grid"
	}
	return "columns-3"
}

// drawBell draws the bell of the title bar: its unread count in the error token while an unread warning or error exists, else in the accent
// (docs/spec/notifications.md#bell).
func (s *Shell) drawBell(c *ui.Context) {
	scale := float32(s.text.Frame())
	unread, problems := s.errors.UnreadNotices()
	badge := func() {
		if unread == 0 {
			return
		}
		m := s.metrics
		tone := s.palette.Focus
		if problems {
			tone = s.palette.No
		}
		h := scale * m.noticeGlyph
		ui.Box(c).Absolute().Top(0).Right(0).MinWidth(h).Height(h).PaddingX(scale * m.toastMorePadX).Radius(h / 2).Background(tone).Center().Children(func() {
			ui.Text(c, strconv.Itoa(unread)).SingleLine().TextColor(s.palette.Card)
		})
	}
	s.drawAct(c, s.binder.Press(c, "core.chrome.notices", "core.notices.toggle", "", nil), s.bellTitle(), "bell", s.errors.noticeOpen, scale, badge)
}
