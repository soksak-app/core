package cgomap

import "testing"

// TestFlags fails unless the generic linker flag of the test set the value.
func TestFlags(t *testing.T) {
	if Value() != "generic" {
		t.Fatalf("value is %q, not the value of the linker flag", Value())
	}
}
