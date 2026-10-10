//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa -framework UserNotifications
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "notifications.h"

extern void notificationEvent(void *context, char *json);
static const char *startNotifications(void) {
    return sp_notifications_start((sp_notification_event)notificationEvent, NULL);
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

// notificationReceiver is the function that receives the notification center events. There is one notification center per process, so only one is kept.
var notificationReceiver func(string)

//export notificationEvent
func notificationEvent(_ unsafe.Pointer, json *C.char) {
	notificationReceiver(C.GoString(json))
}

func (implementation) StartNotifications(receive func(event string)) error {
	notificationReceiver = receive
	if failure := C.startNotifications(); failure != nil {
		return errors.New(C.GoString(failure))
	}
	return nil
}

func (implementation) PostNotification(identifier, title, body string) error {
	name, heading, text := C.CString(identifier), C.CString(title), C.CString(body)
	defer C.free(unsafe.Pointer(name))
	defer C.free(unsafe.Pointer(heading))
	defer C.free(unsafe.Pointer(text))
	C.sp_notifications_post(name, heading, text)
	return nil
}

func (implementation) RemoveNotification(identifier string) error {
	name := C.CString(identifier)
	defer C.free(unsafe.Pointer(name))
	C.sp_notifications_remove(name)
	return nil
}
