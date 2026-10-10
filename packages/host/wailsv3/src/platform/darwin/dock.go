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

// dockNewWindow is the function that the new window item of the Dock menu calls.
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

// PreferredLanguage returns the main tag of the system preferred language (sp_preferred_language of
// window_facts.h). The caller decides whether that tag is a language of the contract table.
func (implementation) PreferredLanguage() (string, error) {
	tag := C.sp_preferred_language()
	defer C.free(unsafe.Pointer(tag))
	return C.GoString(tag), nil
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

func (implementation) MainWindow() (unsafe.Pointer, error) { return C.sp_app_main_window(), nil }

func (implementation) DockSelect(title string) error {
	text := C.CString(title)
	defer C.free(unsafe.Pointer(text))
	if !C.sp_dock_select(text) {
		return fmt.Errorf("Dock menu has no item %q", title)
	}
	return nil
}
