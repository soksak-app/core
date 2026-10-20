package host_test

import (
	"strings"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: host.stall.recorded-without-a-check
func TestABlockedMainThreadIsRecordedWithItsStacksAndItsEnd(t *testing.T) {
	// A fake main thread: the watch sends its heartbeat here, and the test holds the thread for 1.6 s.
	work := make(chan func(), 64)
	hold := make(chan struct{})
	go func() {
		for f := range work {
			f()
		}
	}()
	var mu sync.Mutex
	var events []string
	var fields []map[string]any
	var levels []host.Level
	var names []string
	var sampled []string
	stop := host.StartStallWatch(host.StallWatchOptions{
		OnMain: func(f func()) { work <- f },
		Sample: func(path string) error { mu.Lock(); sampled = append(sampled, path); mu.Unlock(); return nil },
		Folder: t.TempDir(),
		EmitHost: func(level host.Level, event string, f map[string]any) {
			mu.Lock()
			levels = append(levels, level)
			names = append(names, event)
			events = append(events, event)
			fields = append(fields, f)
			mu.Unlock()
		},
	})
	defer stop()
	time.Sleep(600 * time.Millisecond)
	work <- func() { <-hold }
	time.Sleep(1600 * time.Millisecond)
	close(hold)
	time.Sleep(800 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(events, ",") != "host.stall,host.stall.sampled,host.stall.resumed" {
		t.Fatalf("events %v, want one stall, its sample and its end", events)
	}
	if late, _ := fields[0]["late_ms"].(int64); late < 1000 {
		t.Fatalf("late_ms %v, want at least 1000", fields[0]["late_ms"])
	}
	if path, _ := fields[1]["path"].(string); !strings.Contains(path, "stall-host-") || len(sampled) != 1 || sampled[0] != path {
		t.Fatalf("sampled %v into %v", sampled, fields[1])
	}
	if stalled, _ := fields[2]["stalled_ms"].(int64); stalled < 1000 {
		t.Fatalf("stalled_ms %v, want at least 1000", fields[2]["stalled_ms"])
	}
	// The stall and its dump are warnings, which the policy stores through the gate exception of PassesEveryGate; the end of the
	// stall is info.
	for i, name := range names {
		want := host.LevelWarn
		if name == "host.stall.resumed" {
			want = host.LevelInfo
		}
		if levels[i] != want {
			t.Fatalf("%s at %v, want %v", name, levels[i], want)
		}
	}
}
