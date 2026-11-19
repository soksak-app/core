package adapter_test

import (
	"slices"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	host "github.com/soksak-app/core/packages/host/go/src"
	adapter "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// labels collects the names of all items of the menus and submenus in order.
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

// submenuOf finds the submenu whose title is title.
func submenuOf(menu *application.Menu, title string) *application.Menu {
	for index := 0; menu.ItemAt(index) != nil; index++ {
		if item := menu.ItemAt(index); item.Label() == title {
			return item.GetSubmenu()
		}
	}
	return nil
}

// contract: menu.application.view-has-full-screen-and-text-size
func TestApplicationMenuViewHasFullScreenAndTextSize(t *testing.T) {
	// The About item of the app menu reads the application name, so an application that does not run is created.
	application.New(application.Options{Name: "soksak-menu-test"})
	menu, err := adapter.ApplicationMenuFor("en")
	if err != nil {
		t.Fatal(err)
	}
	view := submenuOf(menu, "View")
	if view == nil {
		t.Fatalf("the application menu has no View menu: %v", labels(menu))
	}
	// The builder creates the full screen item because it was measured that the system does not add it (V5-112). The title and
	// shortcut are decided by the framework, so for the fourth item only its existence and a non-empty title are checked.
	want := []string{"Bigger Text", "Smaller Text", "Default Text Size"}
	if got := labels(view)[:3]; !slices.Equal(got, want) {
		t.Fatalf("View menu text items = %v, want %v", got, want)
	}
	if count := len(labels(view)); count != 4 {
		t.Fatalf("View menu items = %d, want 4 (text size and full screen)", count)
	}
	if labels(view)[3] == "" {
		t.Fatal("the full screen item has an empty title")
	}
	// The full screen item is the toggle item of the framework, with its title and its Control-Command F shortcut, which the window
	// check compares across hosts (docs/spec/host-contract.md#application-menu).
	toggle := frameworkItem(application.ToggleFullscreen)
	if got, want := [2]string{view.ItemAt(3).Label(), view.ItemAt(3).GetAccelerator()}, [2]string{toggle.Label(), toggle.GetAccelerator()}; got != want {
		t.Fatalf("the full screen item is %q with the shortcut %q, want the toggle item %q with %q", got[0], got[1], want[0], want[1])
	}
	accelerators := []string{}
	for index := 0; view.ItemAt(index) != nil; index++ {
		accelerators = append(accelerators, view.ItemAt(index).GetAccelerator())
	}
	if !slices.Equal(accelerators[:3], []string{"Cmd+=", "Cmd+-", "Cmd+0"}) {
		t.Fatalf("text size accelerators = %v", accelerators[:3])
	}
	for _, label := range labels(menu) {
		switch label {
		case "Zoom In", "Zoom Out", "Actual Size", "Reload", "Force Reload":
			t.Fatalf("the application menu has %q, which zooms or reloads the whole webview", label)
		}
	}
}

// frameworkItem is the item that Wails builds for role when the host gives it no title and no shortcut: a system item of the
// contract table keeps this title and this shortcut (docs/spec/host-contract.md#application-menu).
func frameworkItem(role application.Role) *application.MenuItem {
	menu := application.NewMenu()
	menu.AddRole(role)
	return menu.FindByRole(role)
}

// contract: menu.application.view-has-full-screen-and-text-size, menu.application.edit-undo-and-redo-are-framework-items
func TestApplicationMenuLanguages(t *testing.T) {
	application.New(application.Options{Name: "soksak-menu-test"})
	// The titles and the item order of the file, edit and view submenus of each language equal the contract table. Undo and redo
	// are system items, so in both languages they have the title and the shortcut that the framework gives their role; AppKit
	// sets the title of an item with the undo: or redo: action from the undo manager when it validates the menu.
	undo, redo := frameworkItem(application.Undo), frameworkItem(application.Redo)
	fullscreen := frameworkItem(application.ToggleFullscreen).Label()
	want := []struct {
		language string
		menu     string
		items    []string
	}{
		{"ko", "파일", []string{"윈도우 닫기"}},
		{"ko", "편집", []string{undo.Label(), redo.Label(), "잘라내기", "복사", "붙여넣기", "모두 선택"}},
		{"ko", "보기", []string{"글자 크게", "글자 작게", "글자 기본 크기", fullscreen}},
		{"en", "File", []string{"Close Window"}},
		{"en", "Edit", []string{undo.Label(), redo.Label(), "Cut", "Copy", "Paste", "Select All"}},
		{"en", "View", []string{"Bigger Text", "Smaller Text", "Default Text Size", fullscreen}},
	}
	menus := map[string]*application.Menu{}
	for _, language := range []string{"ko", "en"} {
		menu, err := adapter.ApplicationMenuFor(language)
		if err != nil {
			t.Fatalf("%s: %v", language, err)
		}
		menus[language] = menu
	}
	for _, expected := range want {
		submenu := submenuOf(menus[expected.language], expected.menu)
		if submenu == nil {
			t.Fatalf("%s menu has no %s submenu: %v", expected.language, expected.menu, labels(menus[expected.language]))
		}
		if got := labels(submenu); !slices.Equal(got, expected.items) {
			t.Fatalf("%s %s items = %v, want %v", expected.language, expected.menu, got, expected.items)
		}
		if expected.menu != "편집" && expected.menu != "Edit" {
			continue
		}
		for role, framework := range map[application.Role]*application.MenuItem{application.Undo: undo, application.Redo: redo} {
			if item := submenu.FindByRole(role); item == nil || item.GetAccelerator() != framework.GetAccelerator() {
				t.Fatalf("%s %s has no item of role %v with the shortcut %q of the framework", expected.language, expected.menu, role, framework.GetAccelerator())
			}
		}
	}
	// A language that is not in the contract table does not build a menu.
	if _, err := adapter.ApplicationMenuFor("fr"); err == nil {
		t.Fatal("an unknown menu language built a menu")
	}
}

// contract: menu.application.help-has-debug
func TestApplicationMenuHelpHasDebug(t *testing.T) {
	application.New(application.Options{Name: "soksak-menu-test"})
	for language, want := range map[string][2]string{"en": {"Help", "Debug"}, "ko": {"도움말", "디버그"}} {
		menu, err := adapter.ApplicationMenuFor(language)
		if err != nil {
			t.Fatal(err)
		}
		help := submenuOf(menu, want[0])
		if help == nil {
			t.Fatalf("the %s application menu has no %s menu: %v", language, want[0], labels(menu))
		}
		if got := labels(help); !slices.Equal(got, []string{want[1]}) {
			t.Fatalf("%s menu items = %v, want [%s]", want[0], got, want[1])
		}
	}
	if command, ok := host.MenuCommand("debug"); !ok || command != "core.debug.open" {
		t.Fatalf("the debug item runs %q (%v), want core.debug.open", command, ok)
	}
}

// contract: menu.application.app-has-settings
func TestApplicationMenuAppHasSettings(t *testing.T) {
	application.New(application.Options{Name: "soksak-menu-test"})
	for language, want := range map[string]string{"en": "Settings…", "ko": "설정…"} {
		menu, err := adapter.ApplicationMenuFor(language)
		if err != nil {
			t.Fatal(err)
		}
		app := menu.ItemAt(0).GetSubmenu()
		if app == nil {
			t.Fatalf("the %s application menu has no app menu: %v", language, labels(menu))
		}
		if got := labels(app); len(got) < 2 || got[1] != want {
			t.Fatalf("the %s app menu = %v, want %q right after the about item", language, got, want)
		}
		if got := app.ItemAt(1).GetAccelerator(); got != "Cmd+," {
			t.Fatalf("the settings item has the key %q", got)
		}
	}
	if command, ok := host.MenuCommand("settings"); !ok || command != "core.settings.open" {
		t.Fatalf("the settings item runs %q (%v), want core.settings.open", command, ok)
	}
}
