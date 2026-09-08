//go:build darwin

package main

/*
#include <stdlib.h>
void nativeRunProbe(void *window, const char *request);
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"log"
	"unsafe"
)

//export nativeProbeResult
func nativeProbeResult(text *C.char) { log.Printf("observe: native %s", C.GoString(text)) }

func observeNative(request string) {
	application.InvokeSync(func() {
		var handle unsafe.Pointer
		if window, ok := mainWindow(); ok {
			handle = window.NativeWindow()
		}
		text := C.CString(request)
		defer C.free(unsafe.Pointer(text))
		C.nativeRunProbe(handle, text)
	})
}
