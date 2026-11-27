package workbench

import "github.com/egoist/mygo/ui"

// drawClosedSettingsHint draws the hint at the bottom right of the work screen after the settings tab of this window was closed: the text
// 설정이 닫혀 있다 and the button 설정 열기, which runs core.settings.open (docs/spec/settings.md#opening-and-closing). It shows only while
// the work screen is in front and only after this window opened the tab, and it hides when the tab opens again.
func (s *Shell) drawClosedSettingsHint(c *ui.Context) {
	if s.settingsWindow.open || !s.settingsWindow.openedOnce || s.browsing || s.opened() == nil {
		return
	}
	m := s.metrics
	box := ui.Box(c).Absolute().Right(s.frameLength(m.spacePad)).Bottom(s.frameLength(m.spacePad))
	box.Row().AlignItems(ui.Center).Gap(s.frameLength(m.chromeGap)).Children(func() {
		ui.Text(c, "설정이 닫혀 있다").SingleLine().FontSize(s.frameFont(s.textControl())).TextColor(s.palette.Muted)
		open := s.binder.Press(c, "core.settings-tab.reopen", "core.settings.open", "", nil)
		open.Height(s.frameLength(m.spaceTabH)).PaddingX(s.frameLength(m.chromeGap)).AlignItems(ui.Center).Radius(s.radiusSmall()).
			Border(s.palette.BorderWidth, s.palette.Edge).Label("설정 열기")
		open.Children(func() {
			ui.Text(c, "설정 열기").SingleLine().FontSize(s.frameFont(s.textControl())).TextColor(s.palette.Fg)
		})
	})
}
