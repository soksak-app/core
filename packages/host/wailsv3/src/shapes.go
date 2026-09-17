// 표면 위에 그리는 외곽선 도형.

package host

import (
	"log"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// ShapeRequest 는 페이지가 표면 위에 그리는 사각형이다.
//
// 도형은 웹뷰가 아니라 레이어 기반 뷰다. 채움과 선은 알파를 갖고 표면의 내용 위에
// 합성된다. 웹뷰는 WebKit 이 불투명 배경을 그리므로 이 합성을 할 수 없다.
type ShapeRequest struct {
	ID        string     `json:"id"`
	Rect      Rect       `json:"rect"`
	Radius    float64    `json:"radius"`
	LineWidth float64    `json:"lineWidth"`
	Fill      [4]float64 `json:"fill"`
	Line      [4]float64 `json:"line"`
}

// nativeShape 는 표면 위에 그리는 레이어 기반 뷰다. 주 스레드에서만 다룬다.
type nativeShape struct{ handle unsafe.Pointer }

func (v *nativeShape) destroy() { system.DestroyShape(v.handle) }

// SetShape 는 사각형을 그리고, 처음 사용할 때 뷰를 만든다.
func (s *Surfaces) SetShape(req ShapeRequest) error {
	win, ok := s.window, s.window != nil
	if !ok {
		return errNoWindow
	}
	x, y := req.Rect.X, req.Rect.Y
	w, h := max1(req.Rect.W), max1(req.Rect.H)
	// 도형은 뷰이고 뷰는 주 스레드에서만 다룬다. 이 맵도 그렇게 다루면 잠금이 필요
	// 없고, 주 스레드가 잠금을 기다리는 일도 없다.
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
		log.Printf("shape %s: %v", req.ID, err)
	}
	return err
}

// ClearShape 는 사각형을 제거한다.
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

// srgba 는 페이지의 0-255 채널을 AppKit 이 받는 0-1 범위로 바꾼다. 알파는 이미 그 범위다.
func srgba(c [4]float64) [4]float64 {
	return [4]float64{c[0] / 255, c[1] / 255, c[2] / 255, c[3]}
}
