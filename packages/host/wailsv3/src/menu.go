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

// menuRoles are the Wails roles that the item ids of the contract table use. The app items also pass through here with the titles of the language table, and
// close-all is not here because the performClose: role of close-window provides it together with the system.
// fullscreen was measured: unlike an earlier measurement that said the system adds it to the View menu by itself, in these apps it does not
// appear even when the menu opens (2026-09-30, V5-112), so it is created here.
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

// menuCommands are the commands that the text size items send to the main window page (docs/spec/text-size.md).
// Menu shortcuts work whichever view has the keyboard focus, so the commands also run from a native image region or a browser
// document.
var menuCommands = map[string]string{
	"text-larger":  "core.text.larger",
	"text-smaller": "core.text.smaller",
	"text-default": "core.text.reset",
	"debug":        "core.debug.open",
}

// MenuCommand returns the page command that the menu item id of the contract table runs, and whether it runs one.
func MenuCommand(id string) (string, bool) {
	command, ok := menuCommands[id]
	return command, ok
}

// menuModifiers converts the shortcut modifier keys of the contract table to Wails modifier keys.
var menuModifiers = map[string]string{
	"cmd":   "CmdOrCtrl",
	"shift": "Shift",
	"ctrl":  "Ctrl",
	// Wails does not recognize "OptOrAlt" but recognizes "OptionOrAlt".
	"opt": "OptionOrAlt",
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

// ApplicationMenu returns the application menu in the current language. Call it after Run set the
// language with InitialMenuLanguage.
func ApplicationMenu() (*application.Menu, error) {
	return ApplicationMenuFor(currentMenuLanguage())
}

// ApplicationMenuFor builds the application menu with the contract table titles of language. The View menu of the Wails default
// menu zooms the whole main web view or reads the main page again. The layout and the native
// surfaces do not follow a web view zoom, and reading again changes the page state. So the View menu has only the full
// screen and text size items.
// menuAppName is the application name used for the title of the app menu and the prefix of about, hide and quit.
// Run sets it with the Wails Options.Name.
var menuAppName = "soksak"

// SetMenuAppName sets the application name that the app menu uses.
func SetMenuAppName(name string) { menuAppName = name }

func ApplicationMenuFor(language string) (*application.Menu, error) {
	if !menuLanguageInTable(language) {
		return nil, fmt.Errorf("menu language %q is not in the menu table", language)
	}
	menu := application.NewMenu()
	for _, row := range menuTable {
		if row.id == "app" {
			// The title of the app menu is the application name, and the item titles come from the contract table.
			// about, hide and quit have the form "<application name> <title>".
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

// addMenuItems builds the menu items of the contract table in order in submenu. close-all is not built because the performClose: role
// of close-window provides it together with the system.
func addMenuItems(submenu *application.Menu, menu, language string) error {
	// close-all is not built. It was measured that when the system finishes the application start, it places a substitute Close All item
	// beside the performClose: of close-window (it is hidden from accessibility). The contract table has it but there is
	// no item to build here. fullscreen was measured not to be added by the system (V5-112), so it is built here.
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
		// The about, hide and quit of app change the title to the form "<application name> <title>".
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

// addTitleItem builds an item that uses the title of the contract table. A text size item builds a command item with the title and
// shortcut of the table, and the others change the title of a role item to the title of the table. The role keeps the behavior, so
// close-window closes the window and undo, redo, cut, copy, paste and select-all perform the edit actions.
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

// addSystemItem builds a role item that keeps the title and shortcut that the framework provides.
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

// addRoleItem puts a role item into submenu and returns that item. Menu.AddRole returns the menu, so
// the role item just put in is found by its role.
func addRoleItem(submenu *application.Menu, role application.Role) *application.MenuItem {
	submenu.AddRole(role)
	return submenu.FindByRole(role)
}

// menuAccelerator converts a shortcut of the contract table (cmd+w) to a Wails shortcut (CmdOrCtrl+w). An empty key is an empty
// shortcut, and a modifier key that is not in the table returns an error.
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

// SetMenuLanguage changes the language of the application menu, rebuilds the menu, and installs it. language must be
// a language of the contract table, and when it equals the current language, nothing happens. It rebuilds the menu on the main thread with the same configuration
// as at the start and installs it with Menu.Set.
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

// runMenuCommand requests the main page of the main application window to run a command. The main window is
// read on the UI thread. It is recorded when there is no main window.
func runMenuCommand(command string) {
	var main unsafe.Pointer
	var err error
	application.InvokeSync(func() { main, err = system.MainWindow() })
	if err != nil {
		LogError("menu command "+command, err)
		return
	}
	for _, window := range application.Get().Window.GetAll() {
		if main != nil && window.NativeWindow() == main {
			window.EmitEvent("menu-command", map[string]any{"name": command})
			return
		}
	}
	LogError("menu command "+command, "no main window")
}
