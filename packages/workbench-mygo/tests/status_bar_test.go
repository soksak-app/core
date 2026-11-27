package workbench_test

import (
	"slices"
	"strings"
	"testing"
)

// The status bar at the bottom of the main window shows the project name, 카드 n, the theme and the mode with ·, and the key hint ⌘, 설정,
// while the work screen or the settings tab is in front; the project home has none (docs/spec/external-sidebars.md#status-bar).
func TestTheStatusBarShowsTheProjectCardsThemeAndKeyHintOnTheWorkScreen(t *testing.T) {
	home := newShell(t, acme())
	// The home hint ↑↓ 이동, Enter 열기, ⌘⌫ 목록에서 빼기, ⌘, 설정 contains the key hint, so the bar is told by its exact text.
	if slices.Contains(home.tester.Texts(), "⌘, 설정") {
		t.Fatal("the project home shows the status bar")
	}
	f := projectWithPlugins(t)
	f.settle()
	if !slices.Contains(f.tester.Texts(), "⌘, 설정") || !f.tester.HasText("카드 2") {
		t.Fatalf("the work screen shows no status bar with the key hint and the card count: %q", f.tester.Texts())
	}
	theme := ""
	for _, text := range f.tester.Texts() {
		if strings.Contains(text, " · ") {
			theme = text
		}
	}
	if theme == "" {
		t.Fatalf("the status bar shows no theme and mode separated by ·: %q", f.tester.Texts())
	}
	f.click("core.chrome.settings", "")
	f.settle()
	if !slices.Contains(f.tester.Texts(), "⌘, 설정") {
		t.Fatal("the status bar is hidden while the settings tab is in front")
	}
}

// The status bar names its three values as elements, so the element tree carries the project name, the card count and the theme
// with its mode (docs/spec/external-sidebars.md#status-bar).
func TestTheStatusBarNamesItsProjectCardsAndThemeElements(t *testing.T) {
	f := projectWithPlugins(t)
	f.settle()
	project, ok := exposedNode(f.tester.ElementTree(), "core.statusbar.project", "")
	if !ok || project.Text == "" {
		t.Fatal("the status bar has no element core.statusbar.project with the project name")
	}
	cards, ok := exposedNode(f.tester.ElementTree(), "core.statusbar.cards", "")
	if !ok || cards.Text != "카드 2" {
		t.Fatalf("the element core.statusbar.cards is %q, want the card count 카드 2", cards.Text)
	}
	theme, ok := exposedNode(f.tester.ElementTree(), "core.statusbar.theme", "")
	if !ok || !strings.Contains(theme.Text, " · ") {
		t.Fatalf("the element core.statusbar.theme is %q, want the theme and mode with ·", theme.Text)
	}
}
