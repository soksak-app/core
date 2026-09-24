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

func (implementation) DockSelect(title string) error {
	text := C.CString(title)
	defer C.free(unsafe.Pointer(text))
	if !C.sp_dock_select(text) {
		return fmt.Errorf("Dock menu has no item %q", title)
	}
	return nil
}
