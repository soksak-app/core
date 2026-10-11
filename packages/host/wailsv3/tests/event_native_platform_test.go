// The pull of the native ring through the platform (docs/spec/logging.md#writers): the host writer starts with the pull of
// the platform, and an empty ring yields no record and no loss.
package host_test

import (
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// contract: log.native.platform-pulls-the-ring
func TestThePlatformPullsAnEmptyNativeRingAsZeroBytesAndNoLoss(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	n, err := system.PullNativeEvents(make([]byte, 4096))
	if err != nil || n != 0 {
		t.Fatalf("pull of an empty ring: %d bytes, %v", n, err)
	}
	for channel := uint8(0); channel < 2; channel++ {
		events, bytes, err := system.TakeNativeEventLoss(channel)
		if err != nil || events != 0 || bytes != 0 {
			t.Fatalf("loss of an empty ring in the channel %d: %d events, %d bytes, %v", channel, events, bytes, err)
		}
	}
	if _, err := system.PullNativeEvents(nil); err == nil {
		t.Fatal("a pull into an empty buffer was accepted")
	}
}

// contract: log.native.platform-takes-the-policy
func TestThePlatformTakesThePolicyOfTheNativeLibraryAndRefusesALevelOutsideTheEnumeration(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = system.SetNativeEventPolicy([5]int8{4, 4, 4, 4, 4}) })
	if err := system.SetNativeEventPolicy([5]int8{4, 3, 2, -1, 0}); err != nil {
		t.Fatalf("a policy of levels and -1 was refused: %v", err)
	}
	for _, bad := range [][5]int8{{4, 4, 4, 4, 5}, {-2, 4, 4, 4, 4}} {
		if err := system.SetNativeEventPolicy(bad); err == nil {
			t.Fatalf("the policy %v was accepted", bad)
		}
	}
}

// contract: log.native.platform-reads-the-clock-and-takes-the-boot
func TestThePlatformReadsAMonotonicClockAndTakesTheBootIdentifier(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	first, err := system.MonotonicNanos()
	if err != nil || first == 0 {
		t.Fatalf("the clock reads %d, %v", first, err)
	}
	time.Sleep(2 * time.Millisecond)
	second, err := system.MonotonicNanos()
	if err != nil || second <= first || second-first > uint64(10*time.Second) {
		t.Fatalf("the clock moved from %d to %d, %v", first, second, err)
	}
	if err := system.SetEventBoot("1791-4242"); err != nil {
		t.Fatalf("a boot identifier of digits and '-' was refused: %v", err)
	}
	for _, bad := range []string{"", "a,b", `a"b`, "a.b", "a b"} {
		if err := system.SetEventBoot(bad); err == nil {
			t.Fatalf("the boot identifier %q was accepted", bad)
		}
	}
}

// contract: log.native.host-writer-starts-with-the-platform-pull
func TestTheHostWriterStartsWithThePullOfThePlatform(t *testing.T) {
	log, err := host.StartHostEventLog(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) == 0 || events[0]["event"] != "log.open" {
		t.Fatalf("events %v", events)
	}
	// The activity observers that the writer installs store native events after log.open and nothing else follows.
	for _, event := range events[1:] {
		if event["layer"] != "native" {
			t.Fatalf("events %v", events)
		}
	}
}
