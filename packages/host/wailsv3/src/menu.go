package host

import (
	"log"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// textSizeItems 는 View 메뉴의 글자 크기 항목이다(docs/spec/text-size.md). 메뉴 단축키는 어느 뷰가
// 키보드 포커스를 가져도 동작하므로 네이티브 터미널 영역이나 브라우저 문서에서도 명령이 실행된다.
var textSizeItems = []struct{ label, accelerator, command string }{
	{"글자 크게", "CmdOrCtrl+=", "core.text.larger"},
	{"글자 작게", "CmdOrCtrl+-", "core.text.smaller"},
	{"글자 기본 크기", "CmdOrCtrl+0", "core.text.reset"},
}

// ApplicationMenu 는 애플리케이션 메뉴다. Wails 기본 메뉴의 View 메뉴는 메인 웹뷰 전체를 확대하거나
// 메인 페이지를 다시 읽는다. 배치와 네이티브 표면은 웹뷰 확대를 따르지 않고, 다시 읽기는 페이지 상태를
// 바꾼다. 그래서 View 메뉴에는 전체 화면과 글자 크기 항목만 둔다.
func ApplicationMenu() *application.Menu {
	menu := application.NewMenu()
	menu.AddRole(application.AppMenu)
	menu.AddRole(application.FileMenu)
	menu.AddRole(application.EditMenu)
	view := menu.AddSubmenu("View")
	view.AddRole(application.ToggleFullscreen)
	for _, item := range textSizeItems {
		command := item.command
		view.Add(item.label).SetAccelerator(item.accelerator).OnClick(func(*application.Context) {
			runMenuCommand(command)
		})
	}
	menu.AddRole(application.WindowMenu)
	menu.AddRole(application.HelpMenu)
	return menu
}

// runMenuCommand 는 애플리케이션 주 창의 메인 페이지에 명령 실행을 요청한다. 주 창은 UI 스레드에서
// 읽는다. 주 창이 없으면 기록한다.
func runMenuCommand(command string) {
	var main unsafe.Pointer
	application.InvokeSync(func() { main = system.MainWindow() })
	for _, window := range application.Get().Window.GetAll() {
		if main != nil && window.NativeWindow() == main {
			window.EmitEvent("menu-command", map[string]any{"name": command})
			return
		}
	}
	log.Printf("menu command %s: no main window", command)
}
