//go:build !darwin

package main

import (
	"fmt"
	"github.com/wailsapp/wails/v3/pkg/application"
	"unsafe"
)

func prepareNativeWindow(unsafe.Pointer) {}
func newNativeWebview(*application.WebviewWindow, nativeWebviewOptions) (*nativeWebview, error) {
	return nil, fmt.Errorf("the example's native webviews are not implemented on this platform")
}
func (v *nativeWebview) NativeView() unsafe.Pointer                   { return nil }
func (v *nativeWebview) SetURL(string) error                          { return fmt.Errorf("native webviews are unavailable") }
func (v *nativeWebview) SetBounds(float64, float64, float64, float64) {}
func (v *nativeWebview) SetHidden(bool)                               {}
func (v *nativeWebview) setBackground(bool)                           {}
func (v *nativeWebview) execJS(string)                                {}
func (v *nativeWebview) Close()                                       {}
