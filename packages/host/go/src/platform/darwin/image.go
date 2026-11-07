//go:build darwin

package darwin

// The surface image region. The implementation is image_region.m of native/darwin.

import (
	"errors"

	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
)

// images are the event receiver handles of each image region handle, and leases the receivers of the released surfaces of
// each region in the lease mode. They are read and changed only in main-thread steps.
var images = map[unsafe.Pointer]handles.Handle{}
var leases = map[unsafe.Pointer]handles.Handle{}

func goHost_image_released(context uintptr, generation, raster uint64, sequence int32) {
	released := handles.Handle(uintptr(context)).Value().(func(uint64, uint64, int))
	released(uint64(generation), uint64(raster), int(sequence))
}

func goHost_image_changed(context uintptr, json *byte) {
	changed := handles.Handle(uintptr(context)).Value().(func(string))
	changed(native.GoString(json))
}

func (implementation) CreateImage(surface unsafe.Pointer, name string, changed func(event string),
	released func(generation, raster uint64, sequence int)) (unsafe.Pointer, error) {
	cname := native.CString(name)
	defer native.Free(unsafe.Pointer(cname))
	receiver := handles.NewHandle(changed)
	var lease handles.Handle
	if released != nil {
		lease = handles.NewHandle(released)
	}
	image := native.ImageCreate(surface, cname, uintptr(receiver), uintptr(lease))
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
	native.MainSpRegionPlace(image, float64(left), float64(top), float64(right), float64(bottom), bool(visible))
}

func (implementation) RasterImage(image unsafe.Pointer) (int, int, float64, bool) {
	var out [3]float64
	ok := bool(native.MainSpRegionRaster(image, &out[0]))
	return int(out[0]), int(out[1]), float64(out[2]), ok
}

func (implementation) SurfacePlacedImage(image unsafe.Pointer) bool {
	return bool(native.MainSpRegionSurfacePlaced(image))
}

func (implementation) PresentImage(image unsafe.Pointer, tokenID uint32, nonce [16]byte, width, height, scale float64,
	generation, raster uint64, sequence int) error {
	if native.MainSpRegionPresent(image, uint32(tokenID), (*byte)(unsafe.Pointer(&nonce[0])), float64(width), float64(height), float64(scale),
		uint64(generation), uint64(raster), int32(sequence)) {
		return nil
	}
	reason := native.MainSpRegionLastError(image)
	if reason == nil {
		return errors.New("image presentation rejected without a native reason")
	}
	defer native.Free(unsafe.Pointer(reason))
	return errors.New(native.GoString(reason))
}

func (implementation) FocusImage(image unsafe.Pointer) {
	native.MainSpRegionFocus(image)
}

func (implementation) CaretImage(image unsafe.Pointer, x, y, w, h float64) {
	native.MainSpRegionCaret(image, float64(x), float64(y), float64(w), float64(h))
}

func (implementation) TextImage(image unsafe.Pointer, utf8 string) {
	ctext := native.CString(utf8)
	defer native.Free(unsafe.Pointer(ctext))
	native.MainSpRegionText(image, ctext)
}

func (implementation) CloseImage(image unsafe.Pointer) {
	// Closing releases the presented surface of a region in the lease mode through its receiver before it returns.
	native.MainSpRegionClose(image)
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
	native.MainSpRegionBackground(image, bool(enabled))
}

func (implementation) FactsImage(image unsafe.Pointer) (string, error) {
	json := native.MainSpRegionFacts(image)
	if json == nil {
		return "", errors.New("cannot get image region facts")
	}
	defer native.Free(unsafe.Pointer(json))
	return native.GoString(json), nil
}
