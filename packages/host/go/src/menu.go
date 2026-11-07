package host

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// The contract table of the top-level menus. (id, ko, en). The title of app is the application name, so it is left empty.
var menuTable = []struct{ id, ko, en string }{
	{"app", "", ""},
	{"file", "파일", "File"},
	{"edit", "편집", "Edit"},
	{"view", "보기", "View"},
	{"window", "윈도우", "Window"},
	{"help", "도움말", "Help"},
}

// The contract table of the menu items. (menu, id, source, ko, en, key). An item whose source is "system" keeps
// the framework title, and an item whose source is "title" uses the title of the table.
var itemTable = []struct{ menu, id, source, ko, en, key string }{
	{"app", "about", "title", "정보", "About", ""},
	{"app", "settings", "title", "설정…", "Settings…", "cmd+,"},
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
	{"help", "debug", "title", "디버그", "Debug", ""},
}

// menuCommands are the commands that the command items of the table send to the main window page (docs/spec/text-size.md).
// Menu shortcuts work whichever view has the keyboard focus, so the commands also run from a native image region or a browser
// document.
var menuCommands = map[string]string{
	"text-larger":  "core.text.larger",
	"text-smaller": "core.text.smaller",
	"text-default": "core.text.reset",
	"debug":        "core.debug.open",
	"settings":     "core.settings.open",
}

// MenuCommand returns the page command that the menu item id of the contract table runs, and whether it runs one.
func MenuCommand(id string) (string, bool) {
	command, ok := menuCommands[id]
	return command, ok
}

// menuWindowNew is the function with which the new window item of the menu opens a window. Run connects Host.WindowNew.
// The Dock menu (installDock) receives the same function. Run creates and connects the menu, so it is set by the time
// an item is clicked.
var menuWindowNew func()

// menuLanguage is the current language of the application menu. Run sets it with InitialMenuLanguage and
// SetMenuLanguage changes it. The thread that builds the menu differs from the thread that reads host.menu, so a lock
// protects it.
var (
	menuLanguageMu sync.Mutex
	menuLanguage   string
)

// currentMenuLanguage returns the current menu language.
func currentMenuLanguage() string {
	menuLanguageMu.Lock()
	defer menuLanguageMu.Unlock()
	return menuLanguage
}

// assignMenuLanguage sets the menu language.
func assignMenuLanguage(language string) {
	menuLanguageMu.Lock()
	menuLanguage = language
	menuLanguageMu.Unlock()
}

// titleOf selects the language title column of the contract table. It returns an error when the language is not in the table. An unsupported
// language is reported as an error and not replaced silently by a default.
func titleOf(language, ko, en string) (string, error) {
	switch language {
	case "ko":
		return ko, nil
	case "en":
		return en, nil
	}
	return "", fmt.Errorf("menu language %q is not in the menu table", language)
}

// menuLanguageInTable returns whether language is a language of the contract table.
func menuLanguageInTable(language string) bool {
	_, err := titleOf(language, "", "")
	return err == nil
}

// InitialMenuLanguage returns the main tag of the system preferred language mapped to a language of the contract table. A language that is not in
// the table is the default language en. It makes the initial menu, before the page reports the settings language, follow the system language
// (Application menu of docs/spec/host-contract.md). It is an error when the system language cannot be read. Call it on the UI
// thread.
func InitialMenuLanguage() (string, error) {
	tag, err := system.PreferredLanguage()
	if err != nil {
		return "", err
	}
	if !menuLanguageInTable(tag) {
		return "en", nil
	}
	return tag, nil
}

// Menu is one top-level menu of the application menu.
type Menu struct {
	Title string
	Items []MenuItem
}

// MenuItem is one item of a menu. Role is the id of the contract table when the framework provides the behavior of the item,
// and Run is the behavior of an item that the host provides. Title and Key are empty when the framework keeps its title and
// its shortcut. Key has the form of the contract table (cmd+w).
type MenuItem struct {
	Role, Title, Key string
	Run              func()
}

// ApplicationMenu returns the application menu in the current language. Call it after the start set the
// language with InitialMenuLanguage.
func ApplicationMenu() ([]Menu, error) {
	return ApplicationMenuFor(currentMenuLanguage())
}

// menuAppName is the application name used for the title of the app menu and the prefix of about, hide and quit.
var menuAppName = "soksak"

// SetMenuAppName sets the application name that the app menu uses.
func SetMenuAppName(name string) { menuAppName = name }

// ApplicationMenuFor returns the application menu with the contract table titles of language. The layout and the native surfaces
// do not follow a web view zoom, and reading a page again changes its state, so the View menu has only the full screen and text
// size items.
func ApplicationMenuFor(language string) ([]Menu, error) {
	if !menuLanguageInTable(language) {
		return nil, fmt.Errorf("menu language %q is not in the menu table", language)
	}
	menus := make([]Menu, 0, len(menuTable))
	for _, row := range menuTable {
		// The title of the app menu is the application name, and the item titles come from the contract table.
		// about, hide and quit have the form "<application name> <title>".
		title := menuAppName
		if row.id != "app" {
			var err error
			if title, err = titleOf(language, row.ko, row.en); err != nil {
				return nil, err
			}
		}
		items, err := tableItems(row.id, language)
		if err != nil {
			return nil, err
		}
		menus = append(menus, Menu{Title: title, Items: items})
	}
	return menus, nil
}

// tableItems returns the menu items of the contract table in order. close-all is not returned because the performClose: role
// of close-window provides it together with the system.
func tableItems(menu, language string) ([]MenuItem, error) {
	// close-all is not built. It was measured that when the system finishes the application start, it places a substitute Close All item
	// beside the performClose: of close-window (it is hidden from accessibility). The contract table has it but there is
	// no item to build here. fullscreen was measured not to be added by the system (V5-112), so it is built here.
	items := []MenuItem{}
	for _, row := range itemTable {
		if row.menu != menu || row.id == "close-all" {
			continue
		}
		title, err := titleOf(language, row.ko, row.en)
		if err != nil {
			return nil, err
		}
		// The about, hide and quit of app change the title to the form "<application name> <title>".
		if menu == "app" && (row.id == "about" || row.id == "hide" || row.id == "quit") {
			title = menuAppName + " " + title
		}
		command, isCommand := menuCommands[row.id]
		switch {
		case row.id == "new-window":
			items = append(items, MenuItem{Title: title, Key: row.key, Run: func() { menuWindowNew() }})
		case row.source == "title" && isCommand:
			// A command item has the title and shortcut of the table.
			items = append(items, MenuItem{Title: title, Key: row.key, Run: func() { runMenuCommand(command) }})
		case row.source == "title":
			// The other items change the title of a role item to the title of the table. The role keeps the behavior, so
			// close-window closes the window and undo, redo, cut, copy, paste and select-all perform the edit actions.
			items = append(items, MenuItem{Role: row.id, Title: title, Key: row.key})
		case row.source == "system":
			items = append(items, MenuItem{Role: row.id})
		default:
			return nil, fmt.Errorf("the menu table item %s/%s has an unknown source %q", row.menu, row.id, row.source)
		}
	}
	return items, nil
}

// SetMenuLanguage changes the language of the application menu, rebuilds the menu, and installs it. language must be
// a language of the contract table, and when it equals the current language, nothing happens. It rebuilds the menu on the main thread with the same configuration
// as at the start and installs it through the framework.
func (h *Host) SetMenuLanguage(ctx context.Context, languageJSON json.RawMessage) error {
	language, err := argument[string]("language", languageJSON)
	if err != nil {
		return err
	}
	if !menuLanguageInTable(language) {
		return fmt.Errorf("menu language %q is not in the menu table", language)
	}
	var failure error
	mainThreadStep(func() {
		if currentMenuLanguage() == language {
			return
		}
		menu, err := ApplicationMenuFor(language)
		if err == nil {
			err = framework.SetMenu(menu)
		}
		if err != nil {
			failure = err
			return
		}
		assignMenuLanguage(language)
	})
	return failure
}

// runMenuCommand requests the main page of the main application window to run a command. The main window is
// read on the UI thread. It is recorded when there is no main window.
func runMenuCommand(command string) {
	var main platform.Window
	var err error
	mainThreadStep(func() { main, err = system.MainWindow() })
	if err != nil {
		LogError("menu command "+command, err)
		return
	}
	for _, window := range framework.Windows() {
		if main != 0 && window.NativeWindow() == main {
			window.Emit("menu-command", map[string]any{"name": command})
			return
		}
	}
	LogError("menu command "+command, "no main window")
}
