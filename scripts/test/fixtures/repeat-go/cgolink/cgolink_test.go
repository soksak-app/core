package cgolink

import "testing"

func TestAlpha(t *testing.T) {
	if Value() != 1 {
		t.Fatal("the C function returned another value")
	}
}
