//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// dockNewWindow is the function that the new window item of the Dock menu calls.
var dockNewWindow func()

func goHost_dock_new_window() { routine.Go("dock-new-window", dockNewWindow) }

func (implementation) InstallDock(newWindow func()) error {
	dockNewWindow = newWindow
	if !native.InstallDockMenu() {
		return errors.New("failed to register the Dock menu")
	}
	return nil
}

func (implementation) DockItems() (string, error) {
	return facts(native.MainSpDockItems(), "Dock menu")
}

func (implementation) MenuItems() (string, error) {
	return facts(native.MainSpMenuItems(), "application menu")
}

// PreferredLanguage returns the main tag of the system preferred language (sp_preferred_language of
// window_facts.h). The caller decides whether that tag is a language of the contract table.
func (implementation) PreferredLanguage() (string, error) {
	tag := native.MainSpPreferredLanguage()
	defer native.Free(unsafe.Pointer(tag))
	return native.GoString(tag), nil
}

func (implementation) MenuSelect(window platform.Window, menu, title string) error {
	menuText, titleText := native.CString(menu), native.CString(title)
	defer native.Free(unsafe.Pointer(menuText))
	defer native.Free(unsafe.Pointer(titleText))
	if failure := native.MainSpMenuSelect(uintptr(window), menuText, titleText); failure != nil {
		return fmt.Errorf("window %d application menu %q item %q: %s", window, menu, title, native.GoString(failure))
	}
	return nil
}

func (implementation) MainWindow() (platform.Window, error) {
	return platform.Window(native.MainSpAppMainWindow()), nil
}

func (implementation) DockSelect(title string) error {
	text := native.CString(title)
	defer native.Free(unsafe.Pointer(text))
	if !native.MainSpDockSelect(text) {
		return fmt.Errorf("Dock menu has no item %q", title)
	}
	return nil
}
