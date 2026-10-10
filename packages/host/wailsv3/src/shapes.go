// The outline shapes drawn over a surface.

package host

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// ShapeRequest is the rectangle that the page draws over a surface.
//
// A shape is a layer-backed view and not a web view. The fill and the line have alpha and are composited over the content of the surface.
// A web view cannot do this composition because WebKit draws an opaque background.
type ShapeRequest struct {
	ID        string     `json:"id"`
	Rect      Rect       `json:"rect"`
	Radius    float64    `json:"radius"`
	LineWidth float64    `json:"lineWidth"`
	Fill      [4]float64 `json:"fill"`
	Line      [4]float64 `json:"line"`
}

// nativeShape is the layer-backed view drawn over a surface. Handle it only on the main thread.
type nativeShape struct{ handle unsafe.Pointer }

func (v *nativeShape) destroy() { system.DestroyShape(v.handle) }

// SetShape draws a rectangle and creates the view on the first use.
func (s *Surfaces) SetShape(req ShapeRequest) error {
	win, ok := s.window, s.window != nil
	if !ok {
		return errNoWindow
	}
	x, y := req.Rect.X, req.Rect.Y
	w, h := max1(req.Rect.W), max1(req.Rect.H)
	// A shape is a view and a view is handled only on the main thread. If this map is handled in the same way, no lock is needed
	// and the main thread never waits for a lock.
	var err error
	application.InvokeSync(func() {
		shape := s.shapes[req.ID]
		if shape == nil {
			var handle unsafe.Pointer
			handle, err = system.CreateShape(win.NativeWindow(), x, y, w, h)
			if err != nil || handle == nil {
				return
			}
			shape = &nativeShape{handle: handle}
			s.shapes[req.ID] = shape
		} else {
			system.SetShapeFrame(shape.handle, x, y, w, h)
		}
		system.SetShapeStyle(shape.handle, req.Radius, req.LineWidth, srgba(req.Fill), srgba(req.Line))
		system.RaiseShape(shape.handle)
	})
	if err != nil {
		LogError("shape "+req.ID, err)
	}
	return err
}

// ClearShape removes the rectangle.
func (s *Surfaces) ClearShape(id string) error {
	application.InvokeSync(func() {
		shape, ok := s.shapes[id]
		if !ok {
			return
		}
		delete(s.shapes, id)
		shape.destroy()
	})
	return nil
}

// srgba converts the 0-255 channels of the page to the 0-1 range that AppKit accepts. Alpha is already in that range.
func srgba(c [4]float64) [4]float64 {
	return [4]float64{c[0] / 255, c[1] / 255, c[2] / 255, c[3]}
}
