package workbench

import (
	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The chrome bar and the tabs of the spaces. The buttons, their order and their commands are those of packages/workbench/index.html
// and projects.js.

// barText is a text button of a bar.
func (s *Shell) barText(c *ui.Context, button ui.Element, label string, on bool) {
	button.Height(s.metrics.spaceTabH).PaddingX(s.metrics.barTabGap).Radius(4).AlignItems(ui.Center).Label(label).Children(func() {
		text := ui.Text(c, label).NoWrap().Ellipsis("…").FontSize(s.frameFont(12)).MaxWidth(s.metrics.barTabMaxW)
		if !on {
			text.TextColor(s.palette.Muted)
		}
	})
	if on {
		button.Background(s.palette.Card)
	}
}

// drawChrome draws the chrome bar of the window.
func (s *Shell) drawChrome(c *ui.Context, width float32) {
	bar := c.TitleBar()
	browsing := s.browsing || s.opened() == nil
	ui.Row(c).Size(width, s.chromeHeight()).PaddingX(s.metrics.barTabGap).AlignItems(ui.Center).Gap(s.metrics.tabsGap).DragWindow().
		Role(ui.RoleGroup).Label("core.chrome.bar").Children(func() {
		ui.Spacer(c).Width(bar.Left)
		ui.Text(c, "soksak").Label("soksak").Bold().FontSize(s.frameFont(13))
		if !browsing {
			s.drawProjectTabs(c)
		}
		ui.Spacer(c).Grow(1)
		if !browsing {
			s.chromeAct(c, "core.chrome.projects", "core.projects.browse", "프로젝트", nil)
			s.chromeAct(c, "core.chrome.balance", "core.layout.balance", "균형", nil)
		}
		s.chromeAct(c, "core.chrome.settings", "core.settings.open", "설정", nil)
	})
}

func (s *Shell) chromeAct(c *ui.Context, name, command, label string, params any) {
	s.barText(c, s.binder.Press(c, name, command, "", params), label, false)
}

// drawProjectTabs draws the tabs of the projects that the window owns, which are the open projects of the window.
func (s *Shell) drawProjectTabs(c *ui.Context) {
	for _, project := range s.projects {
		if project.ID != s.active {
			continue
		}
		ui.Row(c.Key("project-" + project.ID)).AlignItems(ui.Center).Children(func() {
			s.barText(c, s.binder.Press(c, "core.project-tab", "core.project.activate", project.ID, idParam{project.ID}), project.Title, true)
			s.barText(c, s.binder.Press(c, "core.project-tab.close", "core.project.close", project.ID, idParam{project.ID}), "✕", false)
		})
	}
	s.barText(c, s.binder.Press(c, "core.project-tab.add", "core.projects.browse", "", nil), "＋", false)
}

// drawSpaces draws the tabs of the spaces of the project.
func (s *Shell) drawSpaces(c *ui.Context, project *projectRecord, width float32) {
	ui.Row(c).Size(width, s.metrics.spaceTabH+s.metrics.tabsGap).PaddingX(s.metrics.barTabGap).AlignItems(ui.Center).Gap(s.metrics.tabsGap).
		Children(func() {
			for _, space := range project.Spaces {
				s.drawSpaceTab(c, project, space)
			}
			s.barText(c, s.binder.Press(c, "core.space-tab.add", "core.space.add", "", nil), "＋", false)
		})
}

func (s *Shell) drawSpaceTab(c *ui.Context, project *projectRecord, space layout.Space) {
	ui.Row(c.Key("space-" + space.ID)).AlignItems(ui.Center).Children(func() {
		s.barText(c, s.binder.Press(c, "core.space-tab", "core.space.activate", space.ID, idParam{space.ID}), space.Title,
			space.ID == project.ActiveSpaceID)
		if len(project.Spaces) > 1 {
			s.barText(c, s.binder.Press(c, "core.space-tab.close", "core.space.close", space.ID, idParam{space.ID}), "✕", false)
		}
	})
}
