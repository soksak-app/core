// The switch of the performance trace of the host (docs/spec/performance-trace.md): the process holds it, the page turns it
// on and off, an observation is an event of the event log while it is on, and its markers are events too. No file holds the
// switch and no flag reaches a service.
package host_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

func traceEvents(t *testing.T, config string, log *host.EventLog) []string {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if name, _ := event["event"].(string); strings.HasPrefix(name, "host.trace.") {
			names = append(names, name)
		}
	}
	return names
}

// contract: performance.trace.switch-accepts-on-and-off-only
func TestTheSwitchAcceptsOnAndOffOnly(t *testing.T) {
	for _, request := range []map[string]any{
		{},
		{"action": 7},
		{"action": "line", "line": map[string]any{"event": "focus"}},
		{"action": "toggle"},
	} {
		if _, err := host.PerformanceCommand(request); err == nil || !strings.Contains(err.Error(), "action must be on or off") {
			t.Errorf("request %v: error %v", request, err)
		}
	}
	if host.PerformanceEnabled() {
		t.Fatal("a refused request turned the trace on")
	}
}

// contract: performance.trace.switch-is-held-by-the-process
func TestTheProcessHoldsTheSwitchAndNoFileDoes(t *testing.T) {
	config := t.TempDir()
	if err := os.MkdirAll(filepath.Join(config, "services", "fixture-service"), 0o700); err != nil {
		t.Fatal(err)
	}
	log := support.StartWriter(t, config)
	t.Cleanup(func() { _, _ = host.PerformanceCommand(map[string]any{"action": "off"}) })
	observe := func() {
		host.PerformanceObserve("host", func() map[string]any { return map[string]any{"event": "probe", "n": 1} })
	}
	observe()
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	if !host.PerformanceEnabled() {
		t.Fatal("the trace is off after on")
	}
	observe()
	if _, err := host.PerformanceCommand(map[string]any{"action": "off"}); err != nil {
		t.Fatal(err)
	}
	if host.PerformanceEnabled() {
		t.Fatal("the trace is on after off")
	}
	observe()
	// Only the observation made while the trace was on is stored, between the markers.
	if got, want := strings.Join(traceEvents(t, config, log), " "), "host.trace.on host.trace.probe host.trace.off"; got != want {
		t.Fatalf("trace events %q, want %q", got, want)
	}
	// The switch is not a file, the trace is not a file, and a service directory holds no flag.
	for _, path := range []string{"performance", filepath.Join("logs", "performance.ndjson"), filepath.Join("services", "fixture-service", "performance")} {
		if _, err := os.Stat(filepath.Join(config, path)); !os.IsNotExist(err) {
			t.Fatalf("%s exists after the switch: %v", path, err)
		}
	}
}

// contract: performance.trace.already-off-writes-nothing
func TestAlreadyOffWritesNothing(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	if _, err := host.PerformanceCommand(map[string]any{"action": "off"}); err != nil {
		t.Fatal(err)
	}
	if names := traceEvents(t, config, log); len(names) != 0 {
		t.Fatalf("an off request while the trace was off stored %v", names)
	}
}

// contract: performance.sampler.failed-reading-is-explicit
func TestSamplerReportsAFailedReading(t *testing.T) {
	// The resident size of a pid that does not exist cannot be read. It is recorded as an error and not converted to 0.
	record := host.PerformanceMemory(1 << 30)
	if _, ok := record["rss_host_kb"]; ok {
		t.Fatalf("a failed reading was recorded as a size: %v", record)
	}
	if text, _ := record["error"].(string); text == "" {
		t.Fatalf("a failed reading has no error: %v", record)
	}
	own := host.PerformanceMemory(os.Getpid())
	if size, _ := own["rss_host_kb"].(uint64); size == 0 {
		t.Fatalf("the current process has no resident size: %v", own)
	}
}

// contract: performance.sampler.ends-with-the-switch
func TestTheSamplerEndsWhenTheTraceTurnsOff(t *testing.T) {
	t.Cleanup(func() { _, _ = host.PerformanceCommand(map[string]any{"action": "off"}) })
	before := host.PerformanceSamplerRunning()
	if before {
		t.Fatal("a sampler runs while the trace is off")
	}
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	if !host.PerformanceSamplerRunning() {
		t.Fatal("no sampler runs while the trace is on")
	}
	if _, err := host.PerformanceCommand(map[string]any{"action": "off"}); err != nil {
		t.Fatal(err)
	}
	if host.PerformanceSamplerRunning() {
		t.Fatal("the sampler runs after the trace turned off")
	}
	// Turning the trace on again starts a sampler again.
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	if !host.PerformanceSamplerRunning() {
		t.Fatal("no sampler runs after the trace turned on again")
	}
}
