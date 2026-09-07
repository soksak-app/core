//go:build !darwin

package main

import "unsafe"

func beginSurfaceLayout(uint64)                            {}
func commitSurfaceLayout(uint64) bool                      { return true }
func cancelSurfaceLayout()                                 {}
func afterSurfacePresentation(unsafe.Pointer, func()) bool { return false }
