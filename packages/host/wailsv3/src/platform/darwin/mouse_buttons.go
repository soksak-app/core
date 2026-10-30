//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa
#cgo pkg-config: soksak-darwin
#include <stdbool.h>
#include "mouse_buttons.h"
#include "main_thread.h"

// The callback runs its Go function on the worker, and the native call runs on the main thread (main_thread.h).
extern void goMouseButtonsChanged(void *context, unsigned long long mask);
static void mouseButtonsChangedBridge(void *context, unsigned long long mask) {
    wailsRunOnWorker(^{ goMouseButtonsChanged(context, mask); });
}
static bool watchButtons(void) {
    return ON_MAIN(bool, sp_mouse_buttons_watch(mouseButtonsChangedBridge, NULL));
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

// buttonsReceiver is the function that receives the mouse button mask. There is one watch per process, so only one is kept.
var buttonsReceiver func(uint64)

//export goMouseButtonsChanged
func goMouseButtonsChanged(_ unsafe.Pointer, mask C.ulonglong) {
	buttonsReceiver(uint64(mask))
}

// WatchButtons installs the watch with sp_mouse_buttons_watch of native/darwin.
func (implementation) WatchButtons(changed func(mask uint64)) error {
	if buttonsReceiver != nil {
		return errors.New("the mouse buttons are already watched")
	}
	buttonsReceiver = changed
	if !C.watchButtons() {
		buttonsReceiver = nil
		return errors.New("AppKit did not install the mouse button event monitors (sp_mouse_buttons_watch must run once on the main thread)")
	}
	return nil
}
