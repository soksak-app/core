//go:build !darwin

package main

import "unsafe"

func beginSurfaceLayout(_ unsafe.Pointer, _ uint64, ready func(bool)) { ready(true) }
func commitSurfaceLayout(unsafe.Pointer, uint64) bool                 { return true }
func cancelSurfaceLayout(unsafe.Pointer)                              {}
func afterSurfacePresentation(unsafe.Pointer, func()) bool            { return false }
