//go:build !darwin

// The same shape on the platforms this example has not been carried to yet.
// Windows would add a WebView2 controller to the window's HWND and Linux would
// put a WebKitGTK view in the window's container; both are the same idea as the
// macOS file beside this one.
package main

import "unsafe"

type nativeView struct{}

func newNativeView(window unsafe.Pointer, url string, x, y, w, h float64, background [3]float64) *nativeView {
	return nil
}

func (v *nativeView) setFrame(x, y, w, h float64)    {}
func (v *nativeView) setAlpha(alpha float64)         {}
func (v *nativeView) setHidden(hidden bool)          {}
func (v *nativeView) raise()                         {}
func (v *nativeView) setCornerRadius(radius float64) {}
func (v *nativeView) destroy()                       {}
func (v *nativeView) id() uintptr                    { return 0 }

func watchMouse(window unsafe.Pointer) {}

var pressed func(view uintptr) bool

// nativeOverlay is the modal's own window. Not written for this platform.
type nativeOverlay struct{}

func newNativeOverlay(window unsafe.Pointer, url string, x, y, w, h float64,
	background [4]float64, boot string) *nativeOverlay {
	return nil
}

func (v *nativeOverlay) setFrame(x, y, w, h float64)    {}
func (v *nativeOverlay) show()                          {}
func (v *nativeOverlay) hide()                          {}
func (v *nativeOverlay) setCornerRadius(radius float64) {}
func (v *nativeOverlay) eval(js string)                 {}
func (v *nativeOverlay) destroy()                       {}
