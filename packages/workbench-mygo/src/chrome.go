package workbench

import (
	"fmt"

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

// drawChrome draws the chrome bar of the window, a band of the card color with its edge under it.
func (s *Shell) drawChrome(c *ui.Context, width float32) {
	bar := c.TitleBar()
	s.controlsWidth = bar.Left
	browsing := s.browsing || s.opened() == nil
	ui.Row(c).Size(width, s.chromeHeight()).Padding(0, s.metrics.spacePad, 0, s.metrics.spacePad+bar.Left).AlignItems(ui.Center).Gap(s.metrics.chromeGap).
		Background(s.palette.Card).BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Edge).DragWindow().
		Role(ui.RoleGroup).Label("core.chrome.bar").Children(func() {
		ui.Text(c, "soksak").Label("soksak").Bold().FontSize(s.frameFont(13))
		if !browsing {
			ui.Row(c).AlignItems(ui.Center).Gap(s.frameLength(s.metrics.tabsGap)).Children(func() { s.drawProjectTabs(c) })
		}
		ui.Spacer(c).Grow(1)
		if !browsing {
			s.chromeAct(c, "core.chrome.projects", "core.projects.browse", "프로젝트", nil)
			s.chromeAct(c, "core.chrome.balance", "core.layout.balance", "균형", nil)
		}
		if updates := len(s.pluginOperations.Status().Updates); updates > 0 {
			s.chromeAct(c, "core.chrome.updates", "core.plugins.show-updates", fmt.Sprintf("업데이트 %d", updates), nil)
		}
		s.chromeAct(c, "core.chrome.settings", "core.settings.open", "설정", nil)
	})
}

func (s *Shell) chromeAct(c *ui.Context, name, command, label string, params any) {
	s.barText(c, s.binder.Press(c, name, command, "", params), label, false)
}

// barTab is a tab of a bar, the .bar-tab of packages/workbench/app.css: a chip that holds its name and its close button. The chip of the selected tab
// takes the rail color, or tint when the tab has a color of its own.
type barTab struct {
	key, title string
	on         bool
	tint       string
	radius     [4]float32
	pick       func() ui.Element
	close      func() ui.Element
}

func (s *Shell) drawBarTab(c *ui.Context, tab barTab) {
	m := s.metrics
	chip := ui.Row(c.Key(tab.key)).Height(s.frameLength(m.spaceTabH)).Shrink(0).AlignItems(ui.Center).
		Radius(tab.radius[0], tab.radius[1], tab.radius[2], tab.radius[3])
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

// drawProjectTabs draws the tabs of the projects that the window owns, which are the open projects of the window.
func (s *Shell) drawProjectTabs(c *ui.Context) {
	radius := s.radiusSmall()
	for _, project := range s.projects {
		if project.ID != s.active {
			continue
		}
		s.drawBarTab(c, barTab{key: "project-" + project.ID, title: project.Title, on: true, tint: project.Color, radius: [4]float32{radius, radius, radius, radius},
			pick: func() ui.Element {
				return s.binder.Press(c, "core.project-tab", "core.project.activate", project.ID, idParam{project.ID})
			},
			close: func() ui.Element {
				return s.binder.Press(c, "core.project-tab.close", "core.project.close", project.ID, idParam{project.ID})
			}})
	}
	s.drawBarAdd(c, s.binder.Press(c, "core.project-tab.add", "core.projects.browse", "", nil))
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
	tab := barTab{key: "space-" + space.ID, title: space.Title, on: space.ID == project.ActiveSpaceID, radius: [4]float32{radius, radius, 0, 0},
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
