//go:build darwin

package darwin

import (
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

func (implementation) CreateShape(window platform.Window, x, y, w, h float64) (unsafe.Pointer, error) {
	return native.ShapeCreate(uintptr(window), float64(x), float64(y), float64(w), float64(h)), nil
}

func (implementation) SetShapeFrame(shape unsafe.Pointer, x, y, w, h float64) {
	native.ShapeSetFrame(shape, float64(x), float64(y), float64(w), float64(h))
}

func (implementation) SetShapeStyle(shape unsafe.Pointer, radius, lineWidth float64, fill, line [4]float64) {
	native.ShapeSetStyle(shape, float64(radius), float64(lineWidth),
		float64(fill[0]), float64(fill[1]), float64(fill[2]), float64(fill[3]),
		float64(line[0]), float64(line[1]), float64(line[2]), float64(line[3]))
}

func (implementation) RaiseShape(shape unsafe.Pointer) { native.SurfaceRaise(shape) }

func (implementation) DestroyShape(shape unsafe.Pointer) { native.ShapeDestroy(shape) }
