package host

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// 상위 메뉴의 계약 표. (id, ko, en). app 제목은 애플리케이션 이름이므로 비워 둔다.
var menuTable = []struct{ id, ko, en string }{
	{"app", "", ""},
	{"file", "파일", "File"},
	{"edit", "편집", "Edit"},
	{"view", "보기", "View"},
	{"window", "윈도우", "Window"},
	{"help", "도움말", "Help"},
}

// 메뉴 항목의 계약 표. (menu, id, source, ko, en, key). source 가 "system" 인 항목은
// 프레임워크 제목을 유지하고 "title" 인 항목은 표의 제목을 쓴다.
var itemTable = []struct{ menu, id, source, ko, en, key string }{
	{"app", "about", "title", "정보", "About", ""},
	{"app", "services", "system", "", "", ""},
	{"app", "hide", "title", "가리기", "Hide", "cmd+h"},
	{"app", "hide-others", "title", "기타 가리기", "Hide Others", "opt+cmd+h"},
	{"app", "show-all", "title", "모두 보이기", "Show All", ""},
	{"app", "quit", "title", "종료", "Quit", "cmd+q"},
	{"file", "close-window", "title", "윈도우 닫기", "Close Window", "cmd+w"},
	{"file", "close-all", "system", "", "", ""},
	{"edit", "undo", "title", "실행 취소", "Undo", "cmd+z"},
	{"edit", "redo", "title", "다시 실행", "Redo", "shift+cmd+z"},
	{"edit", "cut", "title", "잘라내기", "Cut", "cmd+x"},
	{"edit", "copy", "title", "복사", "Copy", "cmd+c"},
	{"edit", "paste", "title", "붙여넣기", "Paste", "cmd+v"},
	{"edit", "select-all", "title", "모두 선택", "Select All", "cmd+a"},
	{"view", "text-larger", "title", "글자 크게", "Bigger Text", "cmd+="},
	{"view", "text-smaller", "title", "글자 작게", "Smaller Text", "cmd+-"},
	{"view", "text-default", "title", "글자 기본 크기", "Default Text Size", "cmd+0"},
	{"view", "fullscreen", "system", "", "", ""},
	{"window", "new-window", "title", "새 창", "New Window", "shift+cmd+n"},
	{"window", "bring-all-to-front", "system", "", "", ""},
}

// menuRoles 는 계약 표의 항목 id 가 쓰는 Wails 역할이다. app 항목도 언어표 제목과 함께 여기를 지나며
// close-all 은 close-window 의 performClose: 역할이 시스템과 함께 제공하므로 여기에
// 없다. fullscreen 은 시스템이 보기 메뉴에 스스로 넣는다는 과거 측정과 달리 이 앱들에서는
// 메뉴를 열어도 오지 않음을 실측했다(2026-09-30, V5-112) — 여기서 만든다.
var menuRoles = map[string]application.Role{
	"about":              application.About,
	"services":           application.ServicesMenu,
	"hide":               application.Hide,
	"hide-others":        application.HideOthers,
	"show-all":           application.ShowAll,
	"quit":               application.Quit,
	"close-window":       application.CloseWindow,
	"undo":               application.Undo,
	"redo":               application.Redo,
	"cut":                application.Cut,
	"copy":               application.Copy,
	"paste":              application.Paste,
	"select-all":         application.SelectAll,
	"fullscreen":         application.FullScreen,
	"bring-all-to-front": application.BringAllToFront,
}

// menuCommands 는 글자 크기 항목이 주 창 페이지에 보내는 명령이다(docs/spec/text-size.md).
// 메뉴 단축키는 어느 뷰가 키보드 포커스를 가져도 동작하므로 네이티브 터미널 영역이나 브라우저
// 문서에서도 명령이 실행된다.
var menuCommands = map[string]string{
	"text-larger":  "core.text.larger",
	"text-smaller": "core.text.smaller",
	"text-default": "core.text.reset",
}

// menuModifiers 는 계약 표의 단축키 수정 키를 Wails 수정 키로 바꾼다.
var menuModifiers = map[string]string{
	"cmd":   "CmdOrCtrl",
	"shift": "Shift",
	"ctrl":  "Ctrl",
	// Wails 는 "OptOrAlt" 를 인식하지 않고 "OptionOrAlt" 를 인식한다.
	"opt": "OptionOrAlt",
}

// menuWindowNew 는 메뉴의 새 창 항목이 창을 여는 함수다. Run 이 Host.WindowNew 를 연결한다.
// Dock 메뉴(installDock)도 같은 함수를 받는다. 메뉴는 Run 이 만들고 Run 이 연결하므로 항목을
// 클릭하는 시점에는 정해져 있다.
var menuWindowNew func()

// menuLanguage 는 애플리케이션 메뉴의 현재 언어다. Run 이 InitialMenuLanguage 로 정하고
// SetMenuLanguage 가 바꾼다. 메뉴를 만드는 스레드와 host.menu 를 읽는 스레드가 다르므로 잠금으로
// 지킨다.
var (
	menuLanguageMu sync.Mutex
	menuLanguage   string
)

// currentMenuLanguage 는 현재 메뉴 언어를 반환한다.
func currentMenuLanguage() string {
	menuLanguageMu.Lock()
	defer menuLanguageMu.Unlock()
	return menuLanguage
}

// assignMenuLanguage 는 메뉴 언어를 정한다.
func assignMenuLanguage(language string) {
	menuLanguageMu.Lock()
	menuLanguage = language
	menuLanguageMu.Unlock()
}

// titleOf 는 계약 표의 언어 제목 열을 고른다. 표의 언어가 아니면 오류를 반환한다. 지원하지 않는
// 언어는 조용한 기본값 대신 오류로 알린다.
func titleOf(language, ko, en string) (string, error) {
	switch language {
	case "ko":
		return ko, nil
	case "en":
		return en, nil
	}
	return "", fmt.Errorf("menu language %q is not in the menu table", language)
}

// menuLanguageInTable 은 language 가 계약 표의 언어인지 반환한다.
func menuLanguageInTable(language string) bool {
	_, err := titleOf(language, "", "")
	return err == nil
}

// InitialMenuLanguage 는 시스템 선호 언어의 주 태그를 계약 표의 언어와 대응해 반환한다. 표에
// 없는 언어는 기본 언어 en 이다. 페이지가 설정 언어를 알리기 전의 초기 메뉴가 시스템 언어를
// 따르게 한다(docs/spec/host-contract.md 의 Application menu). UI 스레드에서 호출한다.
func InitialMenuLanguage() string {
	tag := system.PreferredLanguage()
	if !menuLanguageInTable(tag) {
		return "en"
	}
	return tag
}

// ApplicationMenu 는 현재 언어의 애플리케이션 메뉴를 반환한다. Run 이 InitialMenuLanguage 로
// 언어를 정한 뒤에 부른다.
func ApplicationMenu() (*application.Menu, error) {
	return ApplicationMenuFor(currentMenuLanguage())
}

// ApplicationMenuFor 는 language 의 계약 표 제목으로 애플리케이션 메뉴를 만든다. Wails 기본
// 메뉴의 View 메뉴는 메인 웹뷰 전체를 확대하거나 메인 페이지를 다시 읽는다. 배치와 네이티브
// 표면은 웹뷰 확대를 따르지 않고, 다시 읽기는 페이지 상태를 바꾼다. 그래서 View 메뉴에는 전체
// 화면과 글자 크기 항목만 둔다.
// menuAppName 은 app 메뉴의 제목과 about·hide·quit 의 접두에 쓰는 애플리케이션 이름이다.
// Run 이 Wails Options.Name 으로 정한다.
var menuAppName = "soksak"

// SetMenuAppName 은 app 메뉴가 쓸 애플리케이션 이름을 정한다.
func SetMenuAppName(name string) { menuAppName = name }

func ApplicationMenuFor(language string) (*application.Menu, error) {
	if !menuLanguageInTable(language) {
		return nil, fmt.Errorf("menu language %q is not in the menu table", language)
	}
	menu := application.NewMenu()
	for _, row := range menuTable {
		if row.id == "app" {
			// app 메뉴의 제목은 애플리케이션 이름이고 항목 제목은 계약표에서 온다.
			// about·hide·quit 는 "앱이름 제목" 꼴이다.
			submenu := menu.AddSubmenu(menuAppName)
			if err := addMenuItems(submenu, row.id, language); err != nil {
				return nil, err
			}
			continue
		}
		title, err := titleOf(language, row.ko, row.en)
		if err != nil {
			return nil, err
		}
		submenu := menu.AddSubmenu(title)
		if err := addMenuItems(submenu, row.id, language); err != nil {
			return nil, err
		}
	}
	return menu, nil
}

// addMenuItems 는 계약 표의 menu 항목을 submenu 에 순서대로 만든다. close-all 은 close-window 의
// performClose: 역할이 시스템과 함께 제공하므로 만들지 않는다.
func addMenuItems(submenu *application.Menu, menu, language string) error {
	// close-all 은 만들지 않는다. 측정하면 시스템이 앱 시작을 마칠 때 close-window 의 performClose:
	// 곁에 Close All 대체 항목을 스스로 놓는다(접근성에서는 숨는다). 계약표에는 있지만 여기서 만들
	// 항목이 없다. fullscreen 은 시스템이 넣어 주지 않음을 실측했으므로(V5-112) 여기서 만든다.
	for _, row := range itemTable {
		if row.menu != menu || row.id == "close-all" {
			continue
		}
		title, err := titleOf(language, row.ko, row.en)
		if err != nil {
			return err
		}
		accelerator, err := menuAccelerator(row.key)
		if err != nil {
			return err
		}
		// app 의 about·hide·quit 는 "앱이름 제목" 꼴로 제목을 바꾼다.
		if menu == "app" && (row.id == "about" || row.id == "hide" || row.id == "quit") {
			title = menuAppName + " " + title
		}
		switch {
		case row.id == "new-window":
			item := submenu.Add(title)
			if accelerator != "" {
				item.SetAccelerator(accelerator)
			}
			item.OnClick(func(*application.Context) { menuWindowNew() })
		case row.source == "title":
			if err := addTitleItem(submenu, row.id, title, accelerator); err != nil {
				return err
			}
		case row.source == "system":
			if err := addSystemItem(submenu, row.id); err != nil {
				return err
			}
		default:
			return fmt.Errorf("the menu table item %s/%s has an unknown source %q", row.menu, row.id, row.source)
		}
	}
	return nil
}

// addTitleItem 은 계약 표의 제목을 쓰는 항목을 만든다. 글자 크기 항목은 표의 제목과 단축키로
// 명령 항목을 만들고, 나머지는 역할 항목의 제목을 표의 제목으로 바꾼다. 역할이 동작을 유지하므로
// close-window 는 창을 닫고 undo·redo·cut·copy·paste·select-all 은 편집 동작을 수행한다.
func addTitleItem(submenu *application.Menu, id, title, accelerator string) error {
	if command, ok := menuCommands[id]; ok {
		item := submenu.Add(title)
		if accelerator != "" {
			item.SetAccelerator(accelerator)
		}
		item.OnClick(func(*application.Context) { runMenuCommand(command) })
		return nil
	}
	role, ok := menuRoles[id]
	if !ok {
		return fmt.Errorf("the menu table has no builder for item %q", id)
	}
	item := addRoleItem(submenu, role)
	if item == nil {
		return fmt.Errorf("menu role %v has no item", role)
	}
	item.SetLabel(title)
	if accelerator != "" {
		item.SetAccelerator(accelerator)
	}
	return nil
}

// addSystemItem 은 프레임워크가 제공하는 제목과 단축키를 유지하는 역할 항목을 만든다.
func addSystemItem(submenu *application.Menu, id string) error {
	role, ok := menuRoles[id]
	if !ok {
		return fmt.Errorf("the menu table has no system role for item %q", id)
	}
	if item := addRoleItem(submenu, role); item == nil {
		return fmt.Errorf("menu role %v has no item", role)
	}
	return nil
}

// addRoleItem 은 역할 항목을 submenu 에 넣고 그 항목을 반환한다. Menu.AddRole 이 메뉴를
// 반환하므로 방금 넣은 역할 항목을 역할로 찾는다.
func addRoleItem(submenu *application.Menu, role application.Role) *application.MenuItem {
	submenu.AddRole(role)
	return submenu.FindByRole(role)
}

// menuAccelerator 는 계약 표의 단축키(cmd+w)를 Wails 단축키(CmdOrCtrl+w)로 바꾼다. 빈 키는 빈
// 단축키이고 표에 없는 수정 키는 오류를 반환한다.
func menuAccelerator(key string) (string, error) {
	if key == "" {
		return "", nil
	}
	parts := strings.Split(key, "+")
	out := make([]string, 0, len(parts))
	for _, part := range parts[:len(parts)-1] {
		mapped, ok := menuModifiers[part]
		if !ok {
			return "", fmt.Errorf("menu key %q has an unknown modifier %q", key, part)
		}
		out = append(out, mapped)
	}
	return strings.Join(append(out, parts[len(parts)-1]), "+"), nil
}

// SetMenuLanguage 는 애플리케이션 메뉴의 언어를 바꾸고 메뉴를 다시 만들어 설치한다. language 는
// 계약 표의 언어여야 하고 현재 언어와 같으면 아무것도 하지 않는다. 시작할 때와 같은 구성으로
// 메인 스레드에서 메뉴를 다시 만들어 Menu.Set 으로 설치한다.
func (h *Host) SetMenuLanguage(ctx context.Context, languageJSON json.RawMessage) error {
	language, err := argument[string]("language", languageJSON)
	if err != nil {
		return err
	}
	if !menuLanguageInTable(language) {
		return fmt.Errorf("menu language %q is not in the menu table", language)
	}
	var failure error
	application.InvokeSync(func() {
		if currentMenuLanguage() == language {
			return
		}
		menu, err := ApplicationMenuFor(language)
		if err != nil {
			failure = err
			return
		}
		application.Get().Menu.Set(menu)
		assignMenuLanguage(language)
	})
	return failure
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
	LogError("menu command "+command, "no main window")
}
