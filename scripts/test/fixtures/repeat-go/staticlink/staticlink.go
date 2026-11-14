// Package staticlink calls a C function that a static library of the pkg-config package soksak-darwin holds.
package staticlink

// #cgo pkg-config: soksak-darwin
// int fixtureStaticValue(void);
import "C"

// Value returns the value of the C function of the linked static library.
func Value() int { return int(C.fixtureStaticValue()) }
