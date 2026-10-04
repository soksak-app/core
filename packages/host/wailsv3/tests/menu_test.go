package host_test

import (
	"slices"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
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

// submenuOf 는 제목이 title 인 하위 메뉴를 찾는다.
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
	// 앱 메뉴의 About 항목은 애플리케이션 이름을 읽으므로 실행하지 않는 애플리케이션을 만든다.
	application.New(application.Options{Name: "soksak-menu-test"})
	menu, err := host.ApplicationMenuFor("en")
	if err != nil {
		t.Fatal(err)
	}
	view := submenuOf(menu, "View")
	if view == nil {
		t.Fatalf("the application menu has no View menu: %v", labels(menu))
	}
	// 전체 화면 항목은 시스템이 넣어 주지 않음을 실측해(V5-112) 빌더가 만든다. 제목과
	// 단축키는 프레임워크가 정하므로 넷째 항목은 존재와 빈 제목 아님만 검사한다.
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

// contract: menu.application.view-has-full-screen-and-text-size
func TestApplicationMenuLanguages(t *testing.T) {
	application.New(application.Options{Name: "soksak-menu-test"})
	// 각 언어의 file·edit·view 하위 메뉴 제목과 항목 순서는 계약 표와 같다.
	want := []struct {
		language string
		menu     string
		items    []string
	}{
		{"ko", "파일", []string{"윈도우 닫기"}},
		{"ko", "편집", []string{"실행 취소", "다시 실행", "잘라내기", "복사", "붙여넣기", "모두 선택"}},
		{"ko", "보기", []string{"글자 크게", "글자 작게", "글자 기본 크기", "Fullscreen"}},
		{"en", "File", []string{"Close Window"}},
		{"en", "Edit", []string{"Undo", "Redo", "Cut", "Copy", "Paste", "Select All"}},
		{"en", "View", []string{"Bigger Text", "Smaller Text", "Default Text Size", "Fullscreen"}},
	}
	menus := map[string]*application.Menu{}
	for _, language := range []string{"ko", "en"} {
		menu, err := host.ApplicationMenuFor(language)
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
	}
	// 계약 표에 없는 언어는 메뉴를 만들지 않는다.
	if _, err := host.ApplicationMenuFor("fr"); err == nil {
		t.Fatal("an unknown menu language built a menu")
	}
}
