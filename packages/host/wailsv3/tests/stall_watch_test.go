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

// controlledTime is a clock that the test controls. Each wait advances it by one beat, and by extra on the first beat, which
// models a process that the system does not schedule for that long; the wait sleeps 1 ms so that the watch does not spin.
type controlledTime struct {
	mu    sync.Mutex
	now   time.Duration
	extra time.Duration
	first bool
}

func (c *controlledTime) clock() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *controlledTime) wait(beat time.Duration) {
	c.mu.Lock()
	c.now += beat
	if c.first {
		c.now += c.extra
		c.first = false
	}
	c.mu.Unlock()
	time.Sleep(time.Millisecond)
}

// firstStall runs the watch with a main thread that never takes a task, and returns the fields of the first host.stall record.
func firstStall(t *testing.T, extra time.Duration) map[string]any {
	t.Helper()
	ct := &controlledTime{extra: extra, first: true}
	records := make(chan struct {
		name   string
		fields map[string]any
	}, 64)
	stop := host.StartStallWatch(host.StallWatchOptions{
		OnMain: func(func()) {},
		Sample: func(string) error { return nil },
		Folder: t.TempDir(),
		EmitHost: func(_ host.Level, event string, fields map[string]any) {
			records <- struct {
				name   string
				fields map[string]any
			}{event, fields}
		},
		Clock: ct.clock,
		Wait:  ct.wait,
	})
	defer stop()
	for {
		select {
		case record := <-records:
			if record.name == "host.stall" {
				return record.fields
			}
		case <-time.After(10 * time.Second):
			t.Fatal("no host.stall record")
		}
	}
}

// int64Field returns a field of a record, which the watch stores as an int64.
func int64Field(t *testing.T, fields map[string]any, key string) int64 {
	t.Helper()
	value, ok := fields[key].(int64)
	if !ok {
		t.Fatalf("host.stall field %s is %v (%T), want an int64", key, fields[key], fields[key])
	}
	return value
}

// contract: host.stall.watch-late-separates-scheduling
func TestAStallOfAnUnscheduledProcessCarriesItsLatenessInTheWatch(t *testing.T) {
	// The first beat is 1600 ms late for the watch and for the main thread alike, so the stall is seen at 1850 ms.
	fields := firstStall(t, 1600*time.Millisecond)
	if got := int64Field(t, fields, "late_ms"); got != 1850 {
		t.Fatalf("late_ms %d, want 1850", got)
	}
	if got := int64Field(t, fields, "watch_late_ms"); got != 1600 {
		t.Fatalf("watch_late_ms %d, want 1600", got)
	}
}

// contract: host.stall.watch-late-separates-blocked-main
func TestAStallOfABlockedMainThreadHasNoLatenessInTheWatch(t *testing.T) {
	// The watch wakes on every beat; the main thread never runs the heartbeat, so the stall is seen at 1000 ms.
	fields := firstStall(t, 0)
	if got := int64Field(t, fields, "late_ms"); got != 1000 {
		t.Fatalf("late_ms %d, want 1000", got)
	}
	if got := int64Field(t, fields, "watch_late_ms"); got != 0 {
		t.Fatalf("watch_late_ms %d, want 0", got)
	}
}
