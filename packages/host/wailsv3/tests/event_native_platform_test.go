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
	events, bytes, err := system.TakeNativeEventLoss()
	if err != nil || events != 0 || bytes != 0 {
		t.Fatalf("loss of an empty ring: %d events, %d bytes, %v", events, bytes, err)
	}
	if _, err := system.PullNativeEvents(nil); err == nil {
		t.Fatal("a pull into an empty buffer was accepted")
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
	if len(events) != 1 || events[0]["event"] != "log.open" {
		t.Fatalf("events %v", events)
	}
}
