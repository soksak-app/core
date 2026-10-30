//go:build darwin

package darwin

/*
#include <stdbool.h>
#include <stdlib.h>
#include "dock_menu.h"
#include "window_facts.h"
#include "main_thread.h"

// The menu action runs its Go function on the worker, and the native calls run on the main thread (main_thread.h).
extern void goDockNewWindow(void);
static bool installDockMenu(void) {
    return ON_MAIN(bool, appInstallDockMenu(^{ wailsRunOnWorker(^{ goDockNewWindow(); }); }));
}
static char *main_sp_dock_items(void) { return ON_MAIN(char *, sp_dock_items()); }
static char *main_sp_menu_items(void) { return ON_MAIN(char *, sp_menu_items()); }
static char *main_sp_preferred_language(void) { return ON_MAIN(char *, sp_preferred_language()); }
static bool main_sp_menu_select(const char *menu, const char *title) { return ON_MAIN(bool, sp_menu_select(menu, title)); }
static void *main_sp_app_main_window(void) { return ON_MAIN(void *, sp_app_main_window()); }
static bool main_sp_dock_select(const char *title) { return ON_MAIN(bool, sp_dock_select(title)); }
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// dockNewWindow is the function that the new window item of the Dock menu calls.
var dockNewWindow func()

//export goDockNewWindow
func goDockNewWindow() { routine.Go("dock-new-window", dockNewWindow) }

func (implementation) InstallDock(newWindow func()) error {
	dockNewWindow = newWindow
	if !C.installDockMenu() {
		return errors.New("failed to register the Dock menu")
	}
	return nil
}

func (implementation) DockItems() (string, error) {
	return facts(C.main_sp_dock_items(), "Dock menu")
}

func (implementation) MenuItems() (string, error) {
	return facts(C.main_sp_menu_items(), "application menu")
}

// PreferredLanguage returns the main tag of the system preferred language (sp_preferred_language of
// window_facts.h). The caller decides whether that tag is a language of the contract table.
func (implementation) PreferredLanguage() (string, error) {
	tag := C.main_sp_preferred_language()
	defer C.free(unsafe.Pointer(tag))
	return C.GoString(tag), nil
}

func (implementation) MenuSelect(menu, title string) error {
	menuText, titleText := C.CString(menu), C.CString(title)
	defer C.free(unsafe.Pointer(menuText))
	defer C.free(unsafe.Pointer(titleText))
	if !C.main_sp_menu_select(menuText, titleText) {
		return fmt.Errorf("application menu %q has no item %q", menu, title)
	}
	return nil
}

func (implementation) MainWindow() (unsafe.Pointer, error) { return C.main_sp_app_main_window(), nil }

func (implementation) DockSelect(title string) error {
	text := C.CString(title)
	defer C.free(unsafe.Pointer(text))
	if !C.main_sp_dock_select(text) {
		return fmt.Errorf("Dock menu has no item %q", title)
	}
	return nil
}
