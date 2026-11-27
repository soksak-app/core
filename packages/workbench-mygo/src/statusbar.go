package workbench

import (
	"fmt"

	"github.com/egoist/mygo/ui"
)

// statusBarHeight is the height of the status bar of the main window, which the work screen and the settings tab show at the bottom
// edge; the project home has none (docs/spec/external-sidebars.md#status-bar). The height is the chrome value statusbar-h.
func (s *Shell) statusBarHeight() float32 {
	if s.browsing || s.opened() == nil {
		return 0
	}
	return float32(s.options.Declared.ChromeNumber("statusbar-h", "px"))
}

// drawStatusBar draws the status bar at the bottom edge of the window: the name of the project, 카드 n for the content cards of the grid,
// the theme and the mode of the window separated by ·, and at the right the key hint ⌘, 설정 (docs/spec/external-sidebars.md#status-bar).
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
	project := s.opened()
	size := s.frameFont(s.textControl())
	theme := fmt.Sprint(s.settings.Value("theme"))
	mode := fmt.Sprint(s.settings.Value("mode"))
	ui.Row(c).Size(width, height).Padding(0, m.spacePad, 0, m.spacePad).AlignItems(ui.Center).Gap(s.frameLength(m.chromeGap)).
		Background(s.palette.Card).BorderWidth(topLine, 0, 0, 0).BorderColor(s.palette.Edge).Role(ui.RoleGroup).Label("core.statusbar").Children(func() {
		ui.Text(s.binder.Name(c, "core.statusbar.project", ""), project.Title).SingleLine().FontSize(size).TextColor(s.palette.Fg)
		ui.Text(s.binder.Name(c, "core.statusbar.cards", ""), fmt.Sprintf("카드 %d", len(s.planes.Cards()))).SingleLine().FontSize(size).TextColor(s.palette.Muted)
		ui.Text(s.binder.Name(c, "core.statusbar.theme", ""), theme+" · "+mode).SingleLine().FontSize(size).TextColor(s.palette.Muted)
		ui.Row(c).Grow(1).Children(func() {})
		ui.Text(c, "⌘, 설정").SingleLine().FontSize(size).TextColor(s.palette.Muted)
	})
}
