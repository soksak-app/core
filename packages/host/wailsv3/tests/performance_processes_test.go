// The sampler and the surface events of the performance trace (docs/spec/performance-trace.md): the sampler reads the
// resident size of every process that the process registry names, and the surface lifecycle events hold the geometry.
package host_test

import (
	"os/exec"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// traceFields returns the fields of the stored events named name, in order.
func traceFields(t *testing.T, config string, log *host.EventLog, name string) []map[string]any {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var found []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if got, _ := event["event"].(string); got == name {
			found = append(found, event["fields"].(map[string]any))
		}
	}
	return found
}

func traceOn(t *testing.T) {
	t.Helper()
	t.Cleanup(func() { _, _ = host.PerformanceCommand(map[string]any{"action": "off"}) })
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
}

// contract: performance.sampler.reads-every-registered-process
func TestTheSamplerReadsEveryRegisteredProcess(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	traceOn(t)
	child := exec.Command("sleep", "30")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	host.PerformanceProcessAdd("sidecar", "fixture", child.Process.Pid)
	host.PerformanceSample()
	var found map[string]any
	for _, fields := range traceFields(t, config, log, "host.sampler.memory") {
		if pid, _ := fields["pid"].(float64); int(pid) == child.Process.Pid {
			found = fields
		}
	}
	if found == nil {
		t.Fatalf("no sample names the registered pid %d", child.Process.Pid)
	}
	if found["role"] != "sidecar" || found["name"] != "fixture" {
		t.Fatalf("the sample does not name the role and the name: %v", found)
	}
	if size, _ := found["rss_kb"].(float64); size <= 0 {
		t.Fatalf("the sample holds no resident size: %v", found)
	}
	// Naming the process stores the event `process` with its role, name and pid.
	var named []map[string]any
	for _, fields := range traceFields(t, config, log, "host.trace.process") {
		if pid, _ := fields["pid"].(float64); int(pid) == child.Process.Pid {
			named = append(named, fields)
		}
	}
	if len(named) != 1 || named[0]["role"] != "sidecar" || named[0]["name"] != "fixture" {
		t.Fatalf("the registry did not store one process event for the pid: %v", named)
	}
	// A removed process is not read again.
	host.PerformanceProcessRemove(child.Process.Pid)
	before := len(traceFields(t, config, log, "host.sampler.memory"))
	host.PerformanceSample()
	for _, fields := range traceFields(t, config, log, "host.sampler.memory")[before:] {
		if pid, _ := fields["pid"].(float64); int(pid) == child.Process.Pid {
			t.Fatalf("a removed process was sampled: %v", fields)
		}
	}
	// A registered process whose size cannot be read is reported with its error, not with a size.
	host.PerformanceProcessAdd("sidecar", "ended", 1<<30)
	t.Cleanup(func() { host.PerformanceProcessRemove(1 << 30) })
	host.PerformanceSample()
	samples := traceFields(t, config, log, "host.sampler.memory")
	failed := samples[len(samples)-1]
	if _, ok := failed["rss_kb"]; ok {
		t.Fatalf("a failed reading was recorded as a size: %v", failed)
	}
	if text, _ := failed["error"].(string); text == "" || failed["pid"] != float64(1<<30) || failed["name"] != "ended" {
		t.Fatalf("a failed reading does not name the process and its error: %v", failed)
	}
}

// contract: performance.surface.lifecycle-events-hold-the-geometry
func TestSurfaceLifecycleEventsHoldTheGeometry(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	traceOn(t)
	host.PerformanceSurface("created", "s1", nil)
	host.PerformanceSurface("placed", "s1", &host.Placement{ID: "s1", Rect: host.Rect{X: 1, Y: 2, W: 30, H: 40}, Visible: true})
	host.PerformanceSurface("destroyed", "s1", nil)
	var phases []string
	var placed map[string]any
	for _, fields := range traceFields(t, config, log, "host.trace.surface") {
		phases = append(phases, fields["phase"].(string))
		if fields["phase"] == "placed" {
			placed = fields
		}
	}
	if got := strings.Join(phases, " "); got != "created placed destroyed" {
		t.Fatalf("surface phases %q", got)
	}
	if placed["surface"] != "s1" || placed["x"] != 1.0 || placed["y"] != 2.0 || placed["w"] != 30.0 || placed["h"] != 40.0 || placed["visible"] != true {
		t.Fatalf("the placed event lacks the geometry: %v", placed)
	}
}
