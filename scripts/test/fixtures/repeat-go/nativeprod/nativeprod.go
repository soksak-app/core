// Package nativeprod is the production native package of the fixture declaration (native-packages.json).
package nativeprod

// value is set by the linker of the tests with -X.
var value = "default"

// Value returns the value that the linker set.
func Value() string { return value }
