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
		window, ok := mainWindow()
		if !ok {
			return
		}
		text := C.CString(request)
		defer C.free(unsafe.Pointer(text))
		C.nativeRunProbe(window.NativeWindow(), text)
	})
}
