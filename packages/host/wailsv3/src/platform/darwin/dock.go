//go:build darwin

package darwin

/*
#include <stdbool.h>
#include "dock_menu.h"

extern void goDockNewWindow(void);
static bool installDockMenu(void) { return appInstallDockMenu(^{ goDockNewWindow(); }); }
*/
import "C"

import "errors"

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
