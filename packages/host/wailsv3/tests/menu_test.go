package host_test

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

// labels 는 메뉴와 하위 메뉴의 모든 항목 이름을 순서대로 모은다.
func labels(menu *application.Menu) []string {
	var out []string
	for index := 0; menu.ItemAt(index) != nil; index++ {
		item := menu.ItemAt(index)
		out = append(out, item.Label())
		if submenu := item.GetSubmenu(); submenu != nil {
			out = append(out, labels(submenu)...)
		}
	}
	return out
}

// contract: menu.application.view-has-only-full-screen
func TestApplicationMenuViewHasOnlyFullScreen(t *testing.T) {
	// 앱 메뉴의 About 항목은 애플리케이션 이름을 읽으므로 실행하지 않는 애플리케이션을 만든다.
	application.New(application.Options{Name: "soksak-menu-test"})
	menu := host.ApplicationMenu()
	var view *application.Menu
	for index := 0; menu.ItemAt(index) != nil; index++ {
		if item := menu.ItemAt(index); item.Label() == "View" {
			view = item.GetSubmenu()
		}
	}
	if view == nil {
		t.Fatalf("the application menu has no View menu: %v", labels(menu))
	}
	if got := labels(view); len(got) != 1 || got[0] != "Toggle Full Screen" {
		t.Fatalf("View menu items = %v, want only Toggle Full Screen", got)
	}
	for _, label := range labels(menu) {
		switch label {
		case "Zoom In", "Zoom Out", "Actual Size", "Reload", "Force Reload":
			t.Fatalf("the application menu has %q, which zooms or reloads the whole webview", label)
		}
	}
}
