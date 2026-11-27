package workbench

import (
	"fmt"

	"github.com/egoist/mygo/ui"
)

// statusBarHeight is the height of the status bar of the main window at the bottom edge. The work screen, the settings tab and the
// project home show it; the project home shows the status line of the home (docs/spec/external-sidebars.md#status-bar).
// The height is the chrome value statusbar-h.
func (s *Shell) statusBarHeight() float32 {
	return float32(s.options.Declared.ChromeNumber("statusbar-h", "px"))
}

// drawStatusBar draws the status bar at the bottom edge of the window: the name of the project, Card n for the content cards of the grid,
// the theme and the mode of the window separated by ·, and at the right the key hint ⌘, Settings (docs/spec/external-sidebars.md#status-bar).
// Its texts are read when it draws.
func (s *Shell) drawStatusBar(c *ui.Context, width float32) {
	height := s.statusBarHeight()
	if height == 0 {
		return
	}
	m := s.metrics
	// At the seam the plane above the bar shares its bottom line with the bar, as the stage shares the lines of the bars above it
	// (stageShare), so the bar draws no line of its own there.
	topLine := s.palette.BorderWidth
	if s.palette.Seam() {
		topLine = 0
	}
	size := s.frameFont(s.textControl())
	if s.browsing || s.opened() == nil {
		s.drawHomeStatus(c, width, height, topLine)
		return
	}
	project := s.opened()
	theme := fmt.Sprint(s.settings.Value("theme"))
	mode := fmt.Sprint(s.settings.Value("mode"))
	ui.Row(c).Size(width, height).Padding(0, m.spacePad, 0, m.spacePad).AlignItems(ui.Center).Gap(s.frameLength(m.chromeGap)).
		Background(s.palette.Card).BorderWidth(topLine, 0, 0, 0).BorderColor(s.palette.Edge).Role(ui.RoleGroup).Label("core.statusbar").Children(func() {
		// The entry Home runs core.home.show, which shows the project home in the window (docs/spec/external-sidebars.md#status-bar).
		s.binder.Press(c, "core.statusbar.home", "core.home.show", "", nil).Role(ui.RoleButton).Label("홈").Children(func() {
			ui.Text(c, "홈").SingleLine().FontSize(size).TextColor(s.palette.Muted)
		})
		ui.Text(s.binder.Name(c, "core.statusbar.project", ""), project.Title).SingleLine().FontSize(size).TextColor(s.palette.Fg)
		ui.Text(s.binder.Name(c, "core.statusbar.cards", ""), fmt.Sprintf("카드 %d", len(s.planes.Cards()))).SingleLine().FontSize(size).TextColor(s.palette.Muted)
		ui.Text(s.binder.Name(c, "core.statusbar.theme", ""), theme+" · "+mode).SingleLine().FontSize(size).TextColor(s.palette.Muted)
		ui.Row(c).Grow(1).Children(func() {})
		ui.Text(c, "⌘, 설정").SingleLine().FontSize(size).TextColor(s.palette.Muted)
	})
}

// drawHomeStatus draws the status line of the project home: the number of projects, the number of open projects, the enabled and the
// installed plugins, the button back to the work screen while the window has one, and at the right the button + New window
// (docs/spec/external-sidebars.md#status-bar).
func (s *Shell) drawHomeStatus(c *ui.Context, width, height, topLine float32) {
	m := s.metrics
	size := s.frameFont(s.textControl())
	open := 0
	for _, project := range s.projects {
		if s.isOpen(project.ID) {
			open++
		}
	}
	enabled, installed := 0, 0
	for _, row := range s.pluginOperations.Status().Plugins {
		if row.Installed != nil {
			installed++
			if row.Installed.Enabled {
				enabled++
			}
		}
	}
	ui.Row(c).Size(width, height).Padding(0, m.spacePad, 0, m.spacePad).AlignItems(ui.Center).Gap(s.frameLength(m.chromeGap)).
		Background(s.palette.Card).BorderWidth(topLine, 0, 0, 0).BorderColor(s.palette.Edge).Role(ui.RoleGroup).Label("core.home.status").Children(func() {
		ui.Text(s.binder.Name(c, "core.home.status.projects", ""), fmt.Sprintf("프로젝트 %d", len(s.projects))).SingleLine().FontSize(size).TextColor(s.palette.Muted)
		ui.Text(c, "·").SingleLine().FontSize(size).TextColor(s.palette.Muted)
		ui.Text(s.binder.Name(c, "core.home.status.open", ""), fmt.Sprintf("열림 %d", open)).SingleLine().FontSize(size).TextColor(s.palette.Muted)
		ui.Text(s.binder.Name(c, "core.home.status.plugins", ""), fmt.Sprintf("플러그인 %d/%d", enabled, installed)).SingleLine().FontSize(size).TextColor(s.palette.Muted)
		if s.returnable() != nil {
			s.binder.Press(c, "core.home.status.back", "core.home.back", "", nil).Role(ui.RoleButton).Label("← 작업 화면으로").Children(func() {
				ui.Text(c, "← 작업 화면으로").SingleLine().FontSize(size).TextColor(s.palette.Fg)
			})
		}
		ui.Row(c).Grow(1).Children(func() {})
		s.binder.Press(c, "core.home.status.new", "core.window.new", "", nil).Role(ui.RoleButton).Label("+ 새 창").Children(func() {
			ui.Text(c, "+ 새 창").SingleLine().FontSize(size).TextColor(s.palette.Muted)
		})
	})
}
