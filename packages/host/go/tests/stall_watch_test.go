package host_test

import (
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// contract: host.stall.carries-priority
func TestThePlatformReadsTheScheduleAndTheCPUTimeOfTheProcessThatAStallCarries(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	_, first, err := system.StallSchedule()
	if err != nil {
		t.Fatalf("the schedule of the process: %v", err)
	}
	_, second, err := system.StallSchedule()
	if err != nil || second < first {
		t.Fatalf("the CPU time of the process moved from %d to %d, %v", first, second, err)
	}
}
