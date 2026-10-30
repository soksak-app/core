//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa -framework UserNotifications
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "notifications.h"
#include "main_thread.h"

// The callback runs its Go function on the worker, and the native calls run on the main thread (main_thread.h).
extern void goNotificationEvent(void *context, char *json);
static void notificationEventBridge(void *context, const char *json) {
    wailsRunOnWorker(^{ goNotificationEvent(context, (char *)json); });
}
static const char *startNotifications(void) {
    return ON_MAIN(const char *, sp_notifications_start(notificationEventBridge, NULL));
}
static void main_sp_notifications_post(const char *identifier, const char *title, const char *body) {
    wailsRunOnMain(^{ sp_notifications_post(identifier, title, body); });
}
static void main_sp_notifications_remove(const char *identifier) { wailsRunOnMain(^{ sp_notifications_remove(identifier); }); }
*/
import "C"

import (
	"errors"
	"unsafe"
)

// notificationReceiver is the function that receives the notification center events. There is one notification center per process, so only one is kept.
var notificationReceiver func(string)

//export goNotificationEvent
func goNotificationEvent(_ unsafe.Pointer, json *C.char) {
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
	C.main_sp_notifications_post(name, heading, text)
	return nil
}

func (implementation) RemoveNotification(identifier string) error {
	name := C.CString(identifier)
	defer C.free(unsafe.Pointer(name))
	C.main_sp_notifications_remove(name)
	return nil
}
