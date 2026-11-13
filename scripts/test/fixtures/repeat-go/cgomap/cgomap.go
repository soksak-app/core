// Package cgomap is a cgo package, so its build uses the external linker of a CGO1 build.
package cgomap

// #include <stdlib.h>
import "C"

// value is set by the linker of the tests with -X.
var value = "default"

// Value returns the value that the linker set.
func Value() string {
	_ = C.abs(0)
	return value
}
