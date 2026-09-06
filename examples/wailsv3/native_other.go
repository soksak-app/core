//go:build !darwin

// The same shape on the platforms this example has not been carried to yet.
//
// A surface and a modal are made by the framework now, so what is left here is
// what this example still does itself: the shapes it draws above the surfaces,
// and reading which view a press landed on. Windows would draw a shape in a
// layered child window and read a press from WM_PARENTNOTIFY; Linux would use a
// GtkDrawingArea in the container and the container's button-press-event.
package main

import "unsafe"

func surfaceFrame(view unsafe.Pointer) Rect { return Rect{} }

func surfaceAlpha(view unsafe.Pointer, alpha float64) {}

func surfaceResizing(view unsafe.Pointer, live bool) {}

func watchMouse(window unsafe.Pointer) {}

var pressed func(view uintptr) bool

var pointed func(phase int, x float64, y float64)

// nativeShape is a rectangle drawn above the surfaces. Not written for this
// platform.
type nativeShape struct{}

func newNativeShape(window unsafe.Pointer, x, y, w, h float64) *nativeShape { return nil }

func (v *nativeShape) setFrame(x, y, w, h float64)                               {}
func (v *nativeShape) setStyle(radius, lineWidth float64, fill, line [4]float64) {}
func (v *nativeShape) raise()                                                    {}
func (v *nativeShape) destroy()                                                  {}

// windowControls reports the area the window's own buttons occupy. Not written
// for this platform; an empty rect means the window draws none.
func windowControls(window unsafe.Pointer) Rect { return Rect{} }

// modalOnScreen converts a point in the parent's content into a screen point.
// Not written for this platform.
func modalOnScreen(parent unsafe.Pointer, at Rect) (int, int) { return 0, 0 }

// modalAligned snaps a modal's rect to the display's pixels. Not written for this
// platform.
func modalAligned(parent unsafe.Pointer, at Rect) Rect { return at }

// modalConfigure configures a modal's window. Not written for this platform.
func modalConfigure(window unsafe.Pointer, title string, radius float64) {}

// modalOrderOut takes the modal's window off the screen. Not written for this
// platform.
func modalOrderOut(window unsafe.Pointer) {}

// windowMakeMain makes this window the main one. Not written for this platform.
func windowMakeMain(window unsafe.Pointer) {}
