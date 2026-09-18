package main_test

import (
	"testing"

	"github.com/min-median-max/soksak/sidecars/ptyd/src/platform"
	_ "github.com/min-median-max/soksak/sidecars/ptyd/src/platform/darwin"
)

func TestCurrentPlatformIsRegistered(t *testing.T) {
	_, err := platform.Current()
	if err != nil {
		t.Fatalf("platform.Current() failed: %v", err)
	}
}
