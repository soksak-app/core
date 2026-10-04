//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa
#cgo pkg-config: soksak-darwin
#include <stdbool.h>
#include "mouse_buttons.h"

extern void mouseButtonsChanged(void *context, unsigned long long mask);
static bool watchButtons(void) {
    return sp_mouse_buttons_watch((sp_mouse_buttons_changed)mouseButtonsChanged, NULL);
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

// buttonsReceiver 는 마우스 버튼 mask 를 받는 함수다. 감시는 프로세스에 하나이므로 하나만 둔다.
var buttonsReceiver func(uint64)

//export mouseButtonsChanged
func mouseButtonsChanged(_ unsafe.Pointer, mask C.ulonglong) {
	buttonsReceiver(uint64(mask))
}

// WatchButtons 는 native/darwin 의 sp_mouse_buttons_watch 로 감시를 설치한다.
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
