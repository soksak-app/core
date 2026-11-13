// Package cgolink calls a C function compiled for a newer macOS version than the link.
package cgolink

// #cgo CFLAGS: -mmacosx-version-min=27.0
// #include "value.h"
import "C"

// Value returns the value of the C function.
func Value() int { return int(C.fixtureValue()) }
