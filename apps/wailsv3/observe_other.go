//go:build !darwin

package main

import "unsafe"

// windowNumbers reports the window server's numbers for this window and the
// windows attached to it. Not written for this platform: Windows would report the
// HWND and Linux the X window id.
func windowNumbers(window unsafe.Pointer) []int { return nil }
