package adapter_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	adapter "github.com/soksak-app/core/packages/host/mygo/src"
	"github.com/soksak-app/core/packages/host/mygo/tests/support"
)

// labels collects the names of the items of a menu.
func labels(items []*mygo.MenuItem) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.Label)
	}
	return out
}

// submenuOf finds the submenu whose title is title.
func submenuOf(menu *mygo.Menu, title string) []*mygo.MenuItem {
	for _, item := range menu.Items() {
		if item.Label == title {
			return item.Submenu
		}
	}
	return nil
}

// contract: menu.application.view-has-full-screen-and-text-size
func TestApplicationMenuViewHasFullScreenAndTextSize(t *testing.T) {
	menu, err := adapter.ApplicationMenuFor("en")
	if err != nil {
		t.Fatal(err)
	}
	view := submenuOf(menu, "View")
	if len(view) != 4 {
		t.Fatalf("View menu items = %v, want text size and full screen", labels(view))
	}
	if got, want := labels(view)[:3], []string{"Bigger Text", "Smaller Text", "Default Text Size"}; !slices.Equal(got, want) {
		t.Fatalf("View menu text items = %v, want %v", got, want)
	}
	if view[3].Role != mygo.RoleToggleFullScreen {
		t.Fatalf("the fourth item of the View menu has the role %q", view[3].Role)
	}
	accelerators := []string{view[0].Accelerator, view[1].Accelerator, view[2].Accelerator}
	if !slices.Equal(accelerators, []string{"CmdOrCtrl+=", "CmdOrCtrl+-", "CmdOrCtrl+0"}) {
		t.Fatalf("text size accelerators = %v", accelerators)
	}
}

// contract: menu.application.view-has-full-screen-and-text-size
func TestApplicationMenuLanguages(t *testing.T) {
	want := []struct {
		language string
		menu     string
		items    []string
	}{
		{"ko", "파일", []string{"윈도우 닫기"}},
		{"ko", "편집", []string{"실행 취소", "다시 실행", "잘라내기", "복사", "붙여넣기", "모두 선택"}},
		{"en", "File", []string{"Close Window"}},
		{"en", "Edit", []string{"Undo", "Redo", "Cut", "Copy", "Paste", "Select All"}},
	}
	for _, expected := range want {
		menu, err := adapter.ApplicationMenuFor(expected.language)
		if err != nil {
			t.Fatalf("%s: %v", expected.language, err)
		}
		if got := labels(submenuOf(menu, expected.menu)); !slices.Equal(got, expected.items) {
			t.Fatalf("%s %s items = %v, want %v", expected.language, expected.menu, got, expected.items)
		}
	}
	if _, err := adapter.ApplicationMenuFor("fr"); err == nil {
		t.Fatal("an unknown menu language built a menu")
	}
}

// contract: mygo.menu.set-menu-builds-the-application-menu
func TestSetMenuInstallsTheMenuInTheApplication(t *testing.T) {
	ran := make(chan struct{}, 1)
	framework := adapter.NewFramework(&support.SceneWorkbench{})
	err := framework.SetMenu([]host.Menu{{Title: "Tools", Items: []host.MenuItem{{Title: "Run", Key: "cmd+shift+r", Run: func() { ran <- struct{}{} }}}}})
	if err != nil {
		t.Fatal(err)
	}
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	var items string
	mygo.RunOnMain(func() { items, err = system.MenuItems() })
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(items, "Tools") || !strings.Contains(items, "Run") {
		t.Fatalf("the application menu holds %s", items)
	}
	_, _, window := support.Open(t, "menu-target")
	mygo.RunOnMain(func() { err = system.MenuSelect(window.NativeWindow(), "Tools", "Run") })
	if err != nil {
		t.Fatal(err)
	}
	<-ran
}

// contract: mygo.menu.set-menu-builds-the-application-menu
func TestAnItemWithAnUnknownRoleOrModifierBuildsNoMenu(t *testing.T) {
	framework := adapter.NewFramework(&support.SceneWorkbench{})
	if err := framework.SetMenu([]host.Menu{{Title: "Tools", Items: []host.MenuItem{{Role: "unknown"}}}}); err == nil {
		t.Fatal("an unknown role built a menu")
	}
	if err := framework.SetMenu([]host.Menu{{Title: "Tools", Items: []host.MenuItem{{Title: "Run", Key: "hyper+r", Run: func() {}}}}}); err == nil {
		t.Fatal("an unknown modifier built a menu")
	}
}

// contract: menu.application.help-has-debug
func TestApplicationMenuHelpHasDebug(t *testing.T) {
	for language, want := range map[string][2]string{"en": {"Help", "Debug"}, "ko": {"도움말", "디버그"}} {
		menu, err := adapter.ApplicationMenuFor(language)
		if err != nil {
			t.Fatal(err)
		}
		help := submenuOf(menu, want[0])
		if help == nil {
			t.Fatalf("the %s application menu has no %s menu", language, want[0])
		}
		if got := labels(help); !slices.Equal(got, []string{want[1]}) {
			t.Fatalf("%s menu items = %v, want [%s]", want[0], got, want[1])
		}
		if help[0].Accelerator != "" {
			t.Fatalf("the debug item has the key %q", help[0].Accelerator)
		}
	}
	if command, ok := host.MenuCommand("debug"); !ok || command != "core.debug.open" {
		t.Fatalf("the debug item runs %q (%v), want core.debug.open", command, ok)
	}
}

// contract: menu.application.app-has-settings
func TestApplicationMenuAppHasSettings(t *testing.T) {
	for language, want := range map[string]string{"en": "Settings…", "ko": "설정…"} {
		menu, err := adapter.ApplicationMenuFor(language)
		if err != nil {
			t.Fatal(err)
		}
		app := menu.Items()[0].Submenu
		if got := labels(app); len(got) < 2 || got[1] != want {
			t.Fatalf("the %s app menu = %v, want %q right after the about item", language, got, want)
		}
		if app[1].Accelerator != "CmdOrCtrl+," {
			t.Fatalf("the settings item has the key %q", app[1].Accelerator)
		}
	}
	if command, ok := host.MenuCommand("settings"); !ok || command != "core.settings.open" {
		t.Fatalf("the settings item runs %q (%v), want core.settings.open", command, ok)
	}
}
