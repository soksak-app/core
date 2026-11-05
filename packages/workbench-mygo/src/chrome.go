package workbench

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The chrome bar and the tabs of the spaces. The buttons, their order and their commands are those of packages/workbench/index.html
// and projects.js.

// barText is a text button of a bar.
func (s *Shell) barText(c *ui.Context, button ui.Element, label string, on bool) {
	s.barTextWithin(c, button, label, on, s.metrics.barTabMaxW)
}

// barTextWithin is barText with a text of at most width.
func (s *Shell) barTextWithin(c *ui.Context, button ui.Element, label string, on bool, width float32) {
	button.Height(s.metrics.spaceTabH).PaddingX(s.metrics.barTabGap).Radius(4).AlignItems(ui.Center).Label(label).Children(func() {
		text := ui.Text(c, label).SingleLine().Ellipsis("…").FontSize(s.frameFont(12)).MaxWidth(width)
		if !on {
			text.TextColor(s.palette.Muted)
		}
	})
	if on {
		button.Background(s.palette.Card)
	}
}

// drawChrome draws the chrome bar of the window, a band of the card color with its edge under it: the logo, the tabs of the projects and the
// switches. The library screen has no layout, so its bar leaves out the project list and the balance.
func (s *Shell) drawChrome(c *ui.Context, width float32) {
	bar := c.TitleBar()
	s.controlsWidth = bar.Left
	browsing := s.browsing || s.opened() == nil
	ui.Row(s.binder.Name(c, "core.chrome.bar", "")).Size(width, s.chromeHeight()).Padding(0, s.metrics.spacePad, 0, s.metrics.spacePad+bar.Left).AlignItems(ui.Center).Gap(s.metrics.chromeGap).
		Background(s.palette.Card).BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Edge).DragWindow().
		Role(ui.RoleGroup).Label("core.chrome.bar").Children(func() {
		s.drawBrand(c)
		ui.Row(c).Grow(1).MinWidth(0).Clip().AlignItems(ui.Center).Gap(s.frameLength(s.metrics.tabsGap)).Children(func() {
			if !browsing && !s.projectsToLeft() {
				s.drawProjectTabs(c, false)
			}
		})
		ui.Row(c).Shrink(0).AlignItems(ui.Center).Gap(s.frameLength(s.metrics.chromeActsGap)).Children(func() { s.drawChromeActs(c, browsing) })
	})
}

// drawBrand draws the logo of the workbench. It does not receive presses, so a press on it drags the window.
func (s *Shell) drawBrand(c *ui.Context) {
	box, _ := s.options.Declared.ChromeText("brand-logo-box")
	var left, top, wide, high float32
	if _, err := fmt.Sscanf(box, "%g %g %g %g", &left, &top, &wide, &high); err != nil {
		s.fail(fmt.Errorf("the chrome value brand-logo-box %q: %w", box, err))
		return
	}
	mode := "brand-text-dark"
	if s.settings.Value("mode") == "light" {
		mode = "brand-text-light"
	}
	text, _ := s.options.Declared.ChromeText(mode)
	height := s.frameLength(float32(s.settings.Value("size").(float64)) * s.metrics.brandLogoAtBase / s.metrics.textBase)
	ui.Box(s.binder.Name(c, "core.brand", "")).Shrink(0).MarginEnd(s.frameLength(s.metrics.brandGap)).Role(ui.RoleImage).Label("soksak").Children(func() {
		// An icon takes one color, and the tile of the logo keeps its own, so the logo is an image with its letters in the color of the mode.
		ui.Image(c, s.declaredIcon(box, "", strings.ReplaceAll(s.options.Declared.Icons["brand-logo"], "currentColor", text))).Size(height*wide/high, height)
	})
}

// drawChromeActs draws the switches of the chrome bar in the order of the page.
func (s *Shell) drawChromeActs(c *ui.Context, browsing bool) {
	if updates := len(s.pluginOperations.Status().Updates); updates > 0 {
		s.chromeTextAct(c, "core.chrome.updates", "core.plugins.show-updates", fmt.Sprintf("업데이트 %d", updates))
	}
	if !browsing {
		s.chromeAct(c, "core.chrome.projects", "core.projects.browse", "프로젝트 목록", "projects", false, nil)
		s.chromeAct(c, "core.chrome.balance", "core.layout.balance", "카드 자동 정렬", "columns-3", false, nil)
	}
	if !browsing {
		for _, side := range []struct{ key, name, title, icon string }{
			{"left", "core.chrome.left", "좌측 사이드바 위치", "panel-left"},
			{"right", "core.chrome.right", "우측 사이드바 위치", "panel-right"},
		} {
			on, _ := s.settings.Value(side.key).(bool)
			s.chromeAct(c, side.name, "core.settings.set", side.title, side.icon, on, settingsPatchParam{map[string]any{side.key: !on}})
		}
	}
	next, icon := "light", "sun"
	if s.settings.Value("mode") != "dark" {
		next, icon = "dark", "moon"
	}
	s.chromeAct(c, "core.chrome.mode", "core.settings.set", "밝게 / 어둡게", icon, false, settingsPatchParam{map[string]any{"mode": next}})
	s.chromeAct(c, "core.chrome.settings", "core.settings.open", "설정", "settings", false, nil)
}

// chromeAct draws an icon switch of the chrome bar, the .act of packages/workbench/app.css.
func (s *Shell) chromeAct(c *ui.Context, name, command, title, icon string, on bool, params any) {
	m := s.metrics
	button := s.binder.Press(c, name, command, "", params)
	button.Size(s.frameLength(m.actW), s.frameLength(m.actH)).Shrink(0).Center().Radius(s.radiusSmall()).Label(title).Tooltip(title)
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
		size := s.frameLength(m.actIcon)
		ui.Icon(c, s.declaredIcon("0 0 24 24", paint, s.options.Declared.Icons[icon])).Size(size, size).TextColor(color)
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
	// column tells that the tab stands in the column of the project tabs, where its name takes the width and its close button stands over the name.
	column bool
	tint   string
	rename renameTarget
	radius [4]float32
	pick   func() ui.Element
	close  func() ui.Element
	// input takes the pointer of the name of the tab, for a tab that can be dragged.
	input func(name ui.Element)
}

func (s *Shell) drawBarTab(c *ui.Context, tab barTab) {
	if s.renaming != nil && s.renaming.renameTarget == tab.rename {
		s.drawRenameField(c)
		return
	}
	m := s.metrics
	chip := ui.Row(c.Key(tab.key)).Height(s.frameLength(m.spaceTabH)).Shrink(0).AlignItems(ui.Center).
		Radius(tab.radius[0], tab.radius[1], tab.radius[2], tab.radius[3])
	if tab.column {
		chip.FillWidth().Height(s.frameLength(m.projectTabH))
	}
	color := s.palette.Muted
	fill := faded(s.palette.Fg, m.chipMix)
	if chip.Hovered() {
		fill = faded(s.palette.Fg, m.chipHoverMix)
	}
	if tab.on {
		color = s.palette.Fg
		fill = faded(s.palette.Rail, m.chipOnMix)
		if tab.tint != "" {
			fill = faded(ui.Hex(tab.tint), m.projectTabMix)
		}
	}
	size := s.frameFont(s.textControl())
	pad := s.frameLength(m.chromeGap)
	chip.Background(fill).Children(func() {
		name := tab.pick()
		if tab.input != nil {
			tab.input(name)
		}
		if name.DoubleClicked() {
			s.binder.run("core.rename.begin", tab.rename)
		}
		name.Padding(0, s.frameLength(m.barGap), 0, pad).AlignItems(ui.Center).Label(tab.title).Tooltip(tab.title)
		widest := s.frameLength(m.barTabMaxW)
		if tab.column {
			widest = s.frameLength(m.projectColumnW) - 2*m.projectColumnPad - 2*m.projectTabPad - 2*s.palette.BorderWidth
			name.Padding(0, m.projectTabPad).FillWidth().Height(s.frameLength(m.projectTabH)).Justify(ui.Center)
		}
		name.Children(func() {
			ui.Text(c, tab.title).SingleLine().Ellipsis("…").FontSize(size).MaxWidth(widest).TextColor(color)
		})
		if tab.close == nil {
			ui.Spacer(c).Width(pad - s.frameLength(m.barGap))
			return
		}
		closing := tab.close()
		closing.PaddingX(s.frameLength(m.barXPad)).Margin(0, pad, 0, 0).Label("닫기").Tooltip("닫기")
		switch {
		case tab.column:
			closing.Absolute().Top(m.projectTabXInset).Right(m.projectTabXInset).Margin(0)
			if !chip.Hovered() {
				closing.Opacity(0)
			}
		case !closing.Hovered():
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

// drawProjectTabs draws the tabs of the projects that the window owns, which are the open projects of the window.
func (s *Shell) drawProjectTabs(c *ui.Context, column bool) {
	radius := s.radiusSmall()
	for _, project := range s.projects {
		s.drawBarTab(c, barTab{key: "project-" + project.ID, title: project.Title, on: project.ID == s.active, tint: project.Color, column: column,
			rename: renameTarget{"project", project.ID}, radius: [4]float32{radius, radius, radius, radius},
			input: func(name ui.Element) {
				s.projectBoxes[project.ID] = name.Bounds()
				name.HandleInput(s.projectTabInput(project.ID, name.Bounds()))
			},
			pick: func() ui.Element {
				return s.binder.Press(c, "core.project-tab", "core.project.activate", project.ID, idParam{project.ID})
			},
			close: func() ui.Element {
				return s.binder.Press(c, "core.project-tab.close", "core.project.close", project.ID, idParam{project.ID})
			}})
	}
	add := s.binder.Press(c, "core.project-tab.add", "core.projects.browse", "", nil)
	if column {
		add.FillWidth().Justify(ui.Center)
	}
	s.drawBarAdd(c, add)
	if column {
		add.Height(s.frameLength(s.metrics.projectTabAddH))
	}
}

// projectTabDrag is a press on a project tab, which moves its project when it ends on another project tab.
type projectTabDrag struct {
	id    string
	x, y  float32
	moved bool
}

// projectTabInput handles the pointer on the name of a project tab. A press that does not move stays a press of the tab.
func (s *Shell) projectTabInput(id string, bounds ui.Rect) func(ui.InputEvent) bool {
	return func(event ui.InputEvent) bool {
		x, y := bounds.X+event.X, bounds.Y+event.Y
		drag := s.projectDrag
		switch event.Kind {
		case ui.InputPointerDown:
			if event.Button == 0 {
				s.projectDrag = &projectTabDrag{id: id, x: x, y: y}
			}
		case ui.InputPointerMove:
			if drag == nil || drag.id != id {
				return false
			}
			drag.moved = drag.moved || math.Hypot(float64(x-drag.x), float64(y-drag.y)) > tabDragThreshold
			return drag.moved
		case ui.InputPointerUp:
			if drag == nil || drag.id != id {
				return false
			}
			s.projectDrag = nil
			if drag.moved {
				s.dropProjectTab(id, x, y)
			}
			return drag.moved
		}
		return false
	}
}

// dropProjectTab moves the project id to the place of the project tab under x and y.
func (s *Shell) dropProjectTab(id string, x, y float32) {
	from := slices.IndexFunc(s.projects, func(project projectRecord) bool { return project.ID == id })
	for to, project := range s.projects {
		box, drawn := s.projectBoxes[project.ID]
		if drawn && to != from && x >= box.X && x < box.X+box.W && y >= box.Y && y < box.Y+box.H {
			s.binder.run("core.project.move", map[string]any{"id": id, "delta": to - from})
			return
		}
	}
}

// projectsToLeft tells whether the project tabs stand in a column at the left of the work screen rather than in the bar.
func (s *Shell) projectsToLeft() bool { return s.settings.Value("projectTabs") == "left" }

// projectColumnWidth is the width of the column of the project tabs on the work screen, 0 when the tabs stand in the bar.
func (s *Shell) projectColumnWidth() float32 {
	if !s.projectsToLeft() {
		return 0
	}
	return float32(math.Round(float64(s.frameLength(s.metrics.projectColumnW))))
}

// drawProjectColumn draws the column of the project tabs, which starts above the space row and goes down to the bottom.
func (s *Shell) drawProjectColumn(c *ui.Context, width, height float32) {
	m := s.metrics
	ui.Column(s.binder.Name(c, "core.projects.column", "")).Role(ui.RoleGroup).Label("프로젝트").Size(width, height).Shrink(0).Gap(m.projectColumnGap).Padding(m.projectColumnPad).Background(s.palette.Card).
		BorderWidth(0, s.palette.BorderWidth, 0, 0).BorderColor(s.palette.Edge).Children(func() { s.drawProjectTabs(c, true) })
}

// drawSpaces draws the row of the spaces of the project, a band of the card color with its edge under it.
func (s *Shell) drawSpaces(c *ui.Context, project *projectRecord, width float32) {
	m := s.metrics
	ui.Row(c).Size(width, s.spaceRowHeight()).Padding(0, s.frameLength(m.spacePad)).AlignItems(ui.Center).Gap(s.frameLength(m.spaceGap)).
		Background(s.palette.Card).BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Edge).Children(func() {
		for _, space := range project.Spaces {
			s.drawSpaceTab(c, project, space)
		}
		s.drawBarAdd(c, s.binder.Press(c, "core.space-tab.add", "core.space.add", "", nil))
	})
}

func (s *Shell) drawSpaceTab(c *ui.Context, project *projectRecord, space layout.Space) {
	radius := s.radiusSmall()
	tab := barTab{key: "space-" + space.ID, title: space.Title, on: space.ID == project.ActiveSpaceID, rename: renameTarget{"space", space.ID}, radius: [4]float32{radius, radius, 0, 0},
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
