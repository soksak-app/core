package host

import "github.com/wailsapp/wails/v3/pkg/application"

// ApplicationMenu 는 애플리케이션 메뉴다. Wails 기본 메뉴의 View 메뉴는 메인 웹뷰 전체를 확대하거나
// 메인 페이지를 다시 읽는다. 배치와 네이티브 표면은 웹뷰 확대를 따르지 않고, 다시 읽기는 페이지 상태를
// 바꾼다. 그래서 View 메뉴에는 Tauri 기본 메뉴처럼 전체 화면만 둔다.
func ApplicationMenu() *application.Menu {
	menu := application.NewMenu()
	menu.AddRole(application.AppMenu)
	menu.AddRole(application.FileMenu)
	menu.AddRole(application.EditMenu)
	menu.AddSubmenu("View").AddRole(application.ToggleFullscreen)
	menu.AddRole(application.WindowMenu)
	menu.AddRole(application.HelpMenu)
	return menu
}
