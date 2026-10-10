package host_test

import (
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: debug.follow.coalesces-writes-into-a-notice
func TestLogNoticesCoalesceToTheLatestWriteWithoutBlockingTheWriter(t *testing.T) {
	type notice struct {
		path string
		size int64
	}
	release := make(chan struct{})
	notices := make(chan notice, 16)
	observe, stop := host.CoalesceLogNotices(func(path string, size int64) {
		<-release
		notices <- notice{path, size}
	})
	defer stop()
	started := time.Now()
	for size := int64(1); size <= 50; size++ {
		observe("logs/host-b1.jsonl", size)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("the writer waited %v for the notices", elapsed)
	}
	close(release)
	var last notice
	for got := 0; got < 2; got++ {
		select {
		case last = <-notices:
		case <-time.After(5 * time.Second):
			t.Fatalf("notice %d did not arrive", got)
		}
		if last.size == 50 {
			break
		}
	}
	if last != (notice{"logs/host-b1.jsonl", 50}) {
		t.Fatalf("the last notice is %+v, want the latest write", last)
	}
	select {
	case extra := <-notices:
		t.Fatalf("a notice %+v follows the latest write", extra)
	case <-time.After(200 * time.Millisecond):
	}
}
