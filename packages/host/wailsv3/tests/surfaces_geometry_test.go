package host_test

import (
	"math"
	"testing"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

func TestValidateRectRejectsNegativeAndNonFiniteSizes(t *testing.T) {
	if err := host.ValidateRect("surface", 0, 0, 0, 10); err != nil {
		t.Fatalf("zero-sized hidden surface should remain valid: %v", err)
	}
	if err := host.ValidateRect("surface", 0, 0, -1, 10); err == nil {
		t.Fatal("negative surface width must be rejected instead of clamped")
	}
	if err := host.ValidateRect("surface", 0, 0, math.NaN(), 10); err == nil {
		t.Fatal("non-finite surface width must be rejected")
	}
}
