//go:build darwin

package darwin

import (
	"errors"
)

// buttonsReceiver is the function that receives the mouse button mask. There is one watch per process, so only one is kept.
var buttonsReceiver func(uint64)

func goHost_mouse_buttons_changed(_ uintptr, mask uint64) {
	buttonsReceiver(uint64(mask))
}

// WatchButtons installs the watch with sp_mouse_buttons_watch of native/darwin.
func (implementation) WatchButtons(changed func(mask uint64)) error {
	if buttonsReceiver != nil {
		return errors.New("the mouse buttons are already watched")
	}
	buttonsReceiver = changed
	if !native.WatchButtons() {
		buttonsReceiver = nil
		return errors.New("AppKit did not install the mouse button event monitors (sp_mouse_buttons_watch must run once on the main thread)")
	}
	return nil
}
