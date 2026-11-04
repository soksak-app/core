//go:build darwin

// Package darwin holds what the tests of the mygo host cannot write in a test file, which takes no cgo.
package darwin

/*
#cgo LDFLAGS: -framework CoreFoundation -framework IOSurface
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurfaceRef.h>

static CFNumberRef number(int value) { return CFNumberCreate(NULL, kCFNumberIntType, &value); }

// frameCreate creates a BGRA surface that carries the nonce of a transfer image.
static IOSurfaceRef frameCreate(int width, int height, const unsigned char *nonce) {
	const void *keys[] = {kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement, kIOSurfacePixelFormat};
	const void *values[] = {number(width), number(height), number(4), number('BGRA')};
	CFDictionaryRef properties = CFDictionaryCreate(NULL, keys, values, 4, &kCFTypeDictionaryKeyCallBacks,
		&kCFTypeDictionaryValueCallBacks);
	for (int index = 0; index < 4; index++) CFRelease(values[index]);
	IOSurfaceRef surface = IOSurfaceCreate(properties);
	CFRelease(properties);
	if (!surface) return NULL;
	CFDataRef data = CFDataCreate(NULL, nonce, 16);
	IOSurfaceSetValue(surface, CFSTR("soksak.frame"), data);
	CFRelease(data);
	return surface;
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

// Frame is a transfer image of a supplier: an IOSurface with the nonce of its region.
type Frame struct {
	surface C.IOSurfaceRef
}

// NewFrame creates a frame of width and height device pixels.
func NewFrame(width, height int, nonce [16]byte) (*Frame, error) {
	surface := C.frameCreate(C.int(width), C.int(height), (*C.uchar)(unsafe.Pointer(&nonce[0])))
	if surface == 0 {
		return nil, errors.New("cannot create an IOSurface")
	}
	return &Frame{surface: surface}, nil
}

// ID is the global identifier of the frame, which a transfer token carries.
func (f *Frame) ID() uint32 { return uint32(C.IOSurfaceGetID(f.surface)) }

// InUse reports the mark of the window server: a layer on screen presents the frame.
func (f *Frame) InUse() bool { return C.IOSurfaceIsInUse(f.surface) != 0 }

// Close releases the reference of the supplier.
func (f *Frame) Close() { C.CFRelease(C.CFTypeRef(f.surface)) }
