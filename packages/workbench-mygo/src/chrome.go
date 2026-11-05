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

// drawChrome draws the chrome bar of the window, a band of the card color with its edge under it: the logo, the tabs of the projects and the
// switches. The library screen has no layout, so its bar leaves out the project list and the balance.
func (s *Shell) drawChrome(c *ui.Context, width float32) {
	bar := c.TitleBar()
	s.controlsWidth = bar.Left
	browsing := s.browsing || s.opened() == nil
	ui.Row(s.binder.Name(c, "core.chrome.bar", "")).Size(width, s.chromeHeight()).Padding(0, s.metrics.spacePad, 0, s.metrics.spacePad+bar.Left).AlignItems(ui.Center).Gap(s.metrics.chromeGap).
		Background(s.palette.Card).BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Edge).DragWindow().
		ObserveInput(s.placeInput(FrameScope())).Role(ui.RoleGroup).Label("core.chrome.bar").Children(func() {
		s.drawBrand(c)
		ui.Row(c).Grow(1).MinWidth(0).Clip().AlignItems(ui.Center).Gap(s.frameLength(s.metrics.tabsGap)).Children(func() {
			if !browsing && s.projectTabsPlace() != "left" {
				for _, project := range s.projects {
					s.drawBarTab(c, s.projectTab(c, project))
				}
				s.drawBarAdd(c, s.binder.Press(c, "core.project-tab.add", "core.projects.browse", "", nil))
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
	s.drawAct(c, s.binder.Press(c, name, command, "", params), title, icon, on, float32(s.text.Frame()))
}

// drawAct draws an icon switch, the .act of packages/workbench/app.css, with its lengths at scale.
func (s *Shell) drawAct(c *ui.Context, button ui.Element, title, icon string, on bool, scale float32) {
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

func (s *Shell) drawBarTab(c *ui.Context, tab barTab) {
	if s.renaming != nil && s.renaming.renameTarget == tab.rename {
		s.drawRenameField(c, s.frameLength(s.metrics.barTabRootW))
		return
	}
	m := s.metrics
	chip := ui.Row(c.Key(tab.key)).Height(s.frameLength(m.spaceTabH)).Shrink(0).AlignItems(ui.Center).
		Radius(tab.radius[0], tab.radius[1], tab.radius[2], tab.radius[3])
	color, fill := s.barTabColors(tab, chip.Hovered())
	size := s.frameFont(s.textControl())
	pad := s.frameLength(m.chromeGap)
	if tab.drop != nil {
		tab.drop(chip)
	}
	chip.Background(fill).Children(func() {
		name := tab.pick()
		if name.DoubleClicked() {
			s.binder.run("core.rename.begin", tab.rename)
		}
		if tab.drag != nil {
			name.Drag(tab.drag)
		}
		name.Padding(0, s.frameLength(m.barGap), 0, pad).AlignItems(ui.Center).Label(tab.title).Tooltip(tab.title).Children(func() {
			ui.Text(c, tab.title).SingleLine().Ellipsis("…").FontSize(size).MaxWidth(s.frameLength(m.barTabMaxW)).TextColor(color)
		})
		if tab.close == nil {
			ui.Spacer(c).Width(pad - s.frameLength(m.barGap))
			return
		}
		closing := tab.close()
		closing.PaddingX(s.frameLength(m.barXPad)).Margin(0, pad, 0, 0).Label("닫기").Tooltip("닫기")
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
	return barTab{key: "project-" + project.ID, title: project.Title, on: project.ID == s.active, tint: project.Color, rename: renameTarget{"project", project.ID},
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

// projectColumnWidth is the width of the column of the project tabs, and 0 while the window has none.
func (s *Shell) projectColumnWidth() float32 {
	if s.inLibrary() || s.projectTabsPlace() != "left" {
		return 0
	}
	return float32(math.Round(float64(s.frameLength(s.metrics.projectColumnW))))
}

// drawWorkArea draws the spaces and the plane of the shown project, beside the column of the project tabs in the left mode. The column
// runs from under the first row to the bottom of the window.
func (s *Shell) drawWorkArea(c *ui.Context, width, height float32) {
	column := s.projectColumnWidth()
	if column == 0 {
		s.drawWork(c, width, height)
		return
	}
	ui.Row(c).Size(width, height).Children(func() {
		s.drawProjectColumn(c, column, height)
		ui.Column(c).Size(width-column, height).Children(func() { s.drawWork(c, width-column, height) })
	})
}

func (s *Shell) drawProjectColumn(c *ui.Context, width, height float32) {
	m := s.metrics
	pad := s.frameLength(m.projectColumnPad)
	ui.Column(s.binder.Name(c, "core.projects.column", "")).Role(ui.RoleGroup).Label("프로젝트 탭").Size(width, height).Shrink(0).Clip().Padding(pad).Gap(s.frameLength(m.projectColumnGap)).
		Background(s.palette.Card).BorderWidth(0, s.palette.BorderWidth, 0, 0).BorderColor(s.palette.Edge).ObserveInput(s.placeInput(FrameScope())).Children(func() {
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

// drawColumnTab draws a tab of the column. The column is wide enough only for the name, so the close button stands over the name until
// the pointer or the focus is on the tab.
func (s *Shell) drawColumnTab(c *ui.Context, tab barTab, width float32) {
	if s.renaming != nil && s.renaming.renameTarget == tab.rename {
		s.drawRenameField(c, width)
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
		if name.DoubleClicked() {
			s.binder.run("core.rename.begin", tab.rename)
		}
		name.Drag(tab.drag).Fill().PaddingX(s.frameLength(m.projectTabPad)).Center().Label(tab.title).Tooltip(tab.title).Children(func() {
			ui.Text(c, tab.title).SingleLine().Ellipsis("…").FontSize(size).TextColor(color)
		})
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
