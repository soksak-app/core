//go:build darwin

package darwin

// The surface image region. The implementation is image_region.m of native/darwin.

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "image_region.h"
#include "main_thread.h"

// The callback runs its Go function on the worker, and the native calls of this file run on the main thread (main_thread.h).
extern void goImageChanged(void *context, char *json);

static void imageChangedBridge(void *context, const char *json) {
    hostRunOnWorker(^{ goImageChanged(context, (char *)json); });
}

extern void goImageReleased(void *context, uint64_t generation, uint64_t raster, int sequence);

static void imageReleasedBridge(void *context, uint64_t generation, uint64_t raster, int sequence) {
    hostRunOnWorker(^{ goImageReleased(context, generation, raster, sequence); });
}

// A nonzero lease puts the region in the lease mode with that receiver of its released surfaces.
static void *imageCreate(void *surface, const char *name, uintptr_t context, uintptr_t lease) {
    return ON_MAIN(void *, ({
        void *region = sp_region_create(surface, name, imageChangedBridge, (void *)context);
        if (region && lease) sp_region_lease(region, imageReleasedBridge, (void *)lease);
        region;
    }));
}
static void main_sp_region_place(void *region, double left, double top, double right, double bottom, bool visible) {
    hostRunOnMain(^{ sp_region_place(region, left, top, right, bottom, visible); });
}
static bool main_sp_region_raster(void *region, double *out) { return ON_MAIN(bool, sp_region_raster(region, out)); }
static bool main_sp_region_surface_placed(void *region) { return ON_MAIN(bool, sp_region_surface_placed(region)); }
static bool main_sp_region_present(void *region, unsigned int token_id, const unsigned char *nonce, double width, double height,
    double scale, uint64_t generation, uint64_t raster, int sequence) {
    return ON_MAIN(bool, sp_region_present(region, token_id, nonce, width, height, scale, generation, raster, sequence));
}
static char *main_sp_region_last_error(void *region) { return ON_MAIN(char *, sp_region_last_error(region)); }
static void main_sp_region_focus(void *region) { hostRunOnMain(^{ sp_region_focus(region); }); }
static void main_sp_region_caret(void *region, double x, double y, double w, double h) {
    hostRunOnMain(^{ sp_region_caret(region, x, y, w, h); });
}
static void main_sp_region_text(void *region, const char *utf8) { hostRunOnMain(^{ sp_region_text(region, utf8); }); }
static void main_sp_region_background(void *region, bool enabled) { hostRunOnMain(^{ sp_region_background(region, enabled); }); }
static const char *main_sp_region_facts(void *region) { return ON_MAIN(const char *, sp_region_facts(region)); }
static void main_sp_region_close(void *region) { hostRunOnMain(^{ sp_region_close(region); }); }
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"unsafe"
)

// images are the event receiver handles of each image region handle, and leases the receivers of the released surfaces of
// each region in the lease mode. They are read and changed only in main-thread steps.
var images = map[unsafe.Pointer]cgo.Handle{}
var leases = map[unsafe.Pointer]cgo.Handle{}

//export goImageReleased
func goImageReleased(context unsafe.Pointer, generation, raster C.uint64_t, sequence C.int) {
	released := cgo.Handle(uintptr(context)).Value().(func(uint64, uint64, int))
	released(uint64(generation), uint64(raster), int(sequence))
}

//export goImageChanged
func goImageChanged(context unsafe.Pointer, json *C.char) {
	changed := cgo.Handle(uintptr(context)).Value().(func(string))
	changed(C.GoString(json))
}

func (implementation) CreateImage(surface unsafe.Pointer, name string, changed func(event string),
	released func(generation, raster uint64, sequence int)) (unsafe.Pointer, error) {
	cname := C.CString(name)
	defer C.free(unsafe.Pointer(cname))
	receiver := cgo.NewHandle(changed)
	var lease cgo.Handle
	if released != nil {
		lease = cgo.NewHandle(released)
	}
	image := C.imageCreate(surface, cname, C.uintptr_t(receiver), C.uintptr_t(lease))
	if image == nil {
		receiver.Delete()
		if lease != 0 {
			lease.Delete()
		}
		return nil, errors.New("cannot create an image region in this surface")
	}
	images[image] = receiver
	if lease != 0 {
		leases[image] = lease
	}
	return image, nil
}

func (implementation) PlaceImage(image unsafe.Pointer, left, top, right, bottom float64, visible bool) {
	C.main_sp_region_place(image, C.double(left), C.double(top), C.double(right), C.double(bottom), C.bool(visible))
}

func (implementation) RasterImage(image unsafe.Pointer) (int, int, float64, bool) {
	var out [3]C.double
	ok := bool(C.main_sp_region_raster(image, &out[0]))
	return int(out[0]), int(out[1]), float64(out[2]), ok
}

func (implementation) SurfacePlacedImage(image unsafe.Pointer) bool {
	return bool(C.main_sp_region_surface_placed(image))
}

func (implementation) PresentImage(image unsafe.Pointer, tokenID uint32, nonce [16]byte, width, height, scale float64,
	generation, raster uint64, sequence int) error {
	if C.main_sp_region_present(image, C.uint(tokenID), (*C.uchar)(unsafe.Pointer(&nonce[0])), C.double(width), C.double(height), C.double(scale),
		C.uint64_t(generation), C.uint64_t(raster), C.int(sequence)) {
		return nil
	}
	reason := C.main_sp_region_last_error(image)
	if reason == nil {
		return errors.New("image presentation rejected without a native reason")
	}
	defer C.free(unsafe.Pointer(reason))
	return errors.New(C.GoString(reason))
}

func (implementation) FocusImage(image unsafe.Pointer) {
	C.main_sp_region_focus(image)
}

func (implementation) CaretImage(image unsafe.Pointer, x, y, w, h float64) {
	C.main_sp_region_caret(image, C.double(x), C.double(y), C.double(w), C.double(h))
}

func (implementation) TextImage(image unsafe.Pointer, utf8 string) {
	ctext := C.CString(utf8)
	defer C.free(unsafe.Pointer(ctext))
	C.main_sp_region_text(image, ctext)
}

func (implementation) CloseImage(image unsafe.Pointer) {
	// Closing releases the presented surface of a region in the lease mode through its receiver before it returns.
	C.main_sp_region_close(image)
	if receiver, ok := images[image]; ok {
		receiver.Delete()
		delete(images, image)
	}
	if lease, ok := leases[image]; ok {
		lease.Delete()
		delete(leases, image)
	}
}

func (implementation) SetImageBackground(image unsafe.Pointer, enabled bool) {
	C.main_sp_region_background(image, C.bool(enabled))
}

func (implementation) FactsImage(image unsafe.Pointer) (string, error) {
	json := C.main_sp_region_facts(image)
	if json == nil {
		return "", errors.New("cannot get image region facts")
	}
	defer C.free(unsafe.Pointer(json))
	return C.GoString(json), nil
}
