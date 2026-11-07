//go:build darwin

package darwin

import (
	"errors"
	"unsafe"
)

// notificationReceiver is the function that receives the notification center events. There is one notification center per process, so only one is kept.
var notificationReceiver func(string)

func goHost_notification_event(_ uintptr, json *byte) {
	notificationReceiver(native.GoString(json))
}

func (implementation) StartNotifications(receive func(event string)) error {
	notificationReceiver = receive
	if failure := native.StartNotifications(); failure != nil {
		return errors.New(native.GoString(failure))
	}
	return nil
}

func (implementation) PostNotification(identifier, title, body string) error {
	name, heading, text := native.CString(identifier), native.CString(title), native.CString(body)
	defer native.Free(unsafe.Pointer(name))
	defer native.Free(unsafe.Pointer(heading))
	defer native.Free(unsafe.Pointer(text))
	native.MainSpNotificationsPost(name, heading, text)
	return nil
}

func (implementation) RemoveNotification(identifier string) error {
	name := native.CString(identifier)
	defer native.Free(unsafe.Pointer(name))
	native.MainSpNotificationsRemove(name)
	return nil
}
