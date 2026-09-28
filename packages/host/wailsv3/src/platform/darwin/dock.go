//go:build darwin

package darwin

/*
#include <stdbool.h>
#include <stdlib.h>
#include "dock_menu.h"
#include "window_facts.h"

extern void goDockNewWindow(void);
static bool installDockMenu(void) { return appInstallDockMenu(^{ goDockNewWindow(); }); }
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"
)

// dockNewWindow 는 Dock 메뉴의 새 창 항목이 호출하는 함수다.
var dockNewWindow func()

//export goDockNewWindow
func goDockNewWindow() { go dockNewWindow() }

func (implementation) InstallDock(newWindow func()) error {
	dockNewWindow = newWindow
	if !C.installDockMenu() {
		return errors.New("failed to register the Dock menu")
	}
	return nil
}

func (implementation) DockItems() (string, error) {
	return facts(C.sp_dock_items(), "Dock menu")
}

func (implementation) MenuItems() (string, error) {
	return facts(C.sp_menu_items(), "application menu")
}

// PreferredLanguage 는 시스템 선호 언어의 주 태그를 반환한다(window_facts.h 의
// sp_preferred_language). 그 태그가 계약 표의 언어인지는 호출자가 정한다.
func (implementation) PreferredLanguage() string {
	tag := C.sp_preferred_language()
	defer C.free(unsafe.Pointer(tag))
	return C.GoString(tag)
}

func (implementation) MenuSelect(menu, title string) error {
	menuText, titleText := C.CString(menu), C.CString(title)
	defer C.free(unsafe.Pointer(menuText))
	defer C.free(unsafe.Pointer(titleText))
	if !C.sp_menu_select(menuText, titleText) {
		return fmt.Errorf("application menu %q has no item %q", menu, title)
	}
	return nil
}

func (implementation) MainWindow() unsafe.Pointer { return C.sp_app_main_window() }

func (implementation) DockSelect(title string) error {
	text := C.CString(title)
	defer C.free(unsafe.Pointer(text))
	if !C.sp_dock_select(text) {
		return fmt.Errorf("Dock menu has no item %q", title)
	}
	return nil
}
