//go:build darwin

package darwin

// 표면 그림 영역. 구현은 native/darwin 의 image_region.m 이다.

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "image_region.h"

extern void imageChanged(void *context, char *json);

static void imageChangedBridge(void *context, const char *json) {
    imageChanged(context, (char *)json);
}

static void *imageCreate(void *surface, const char *name, uintptr_t context) {
    return sp_region_create(surface, name, imageChangedBridge, (void *)context);
}
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"unsafe"
)

// images 는 그림 영역 핸들별 이벤트 수신 핸들이다. UI 스레드에서만 읽고 바꾼다.
var images = map[unsafe.Pointer]cgo.Handle{}

//export imageChanged
func imageChanged(context unsafe.Pointer, json *C.char) {
	changed := cgo.Handle(uintptr(context)).Value().(func(string))
	changed(C.GoString(json))
}

func (implementation) CreateImage(surface unsafe.Pointer, name string, changed func(event string)) (unsafe.Pointer, error) {
	cname := C.CString(name)
	defer C.free(unsafe.Pointer(cname))
	receiver := cgo.NewHandle(changed)
	image := C.imageCreate(surface, cname, C.uintptr_t(receiver))
	if image == nil {
		receiver.Delete()
		return nil, errors.New("cannot create an image region in this surface")
	}
	images[image] = receiver
	return image, nil
}

func (implementation) PlaceImage(image unsafe.Pointer, left, top, right, bottom float64, visible bool) {
	C.sp_region_place(image, C.double(left), C.double(top), C.double(right), C.double(bottom), C.bool(visible))
}

func (implementation) RasterImage(image unsafe.Pointer) (int, int, float64, bool) {
	var out [3]C.double
	ok := bool(C.sp_region_raster(image, &out[0]))
	return int(out[0]), int(out[1]), float64(out[2]), ok
}

func (implementation) PresentImage(image unsafe.Pointer, tokenID uint32, nonce [16]byte, width, height, scale float64) bool {
	return bool(C.sp_region_present(image, C.uint(tokenID), (*C.uchar)(unsafe.Pointer(&nonce[0])), C.double(width), C.double(height), C.double(scale)))
}

func (implementation) FocusImage(image unsafe.Pointer) {
	C.sp_region_focus(image)
}

func (implementation) CaretImage(image unsafe.Pointer, x, y, w, h float64) {
	C.sp_region_caret(image, C.double(x), C.double(y), C.double(w), C.double(h))
}

func (implementation) TextImage(image unsafe.Pointer, utf8 string) {
	ctext := C.CString(utf8)
	defer C.free(unsafe.Pointer(ctext))
	C.sp_region_text(image, ctext)
}

func (implementation) CloseImage(image unsafe.Pointer) {
	C.sp_region_close(image)
	if receiver, ok := images[image]; ok {
		receiver.Delete()
		delete(images, image)
	}
}

func (implementation) FactsImage(image unsafe.Pointer) (string, error) {
	json := C.sp_region_facts(image)
	if json == nil {
		return "", errors.New("cannot get image region facts")
	}
	defer C.free(unsafe.Pointer(json))
	return C.GoString(json), nil
}
