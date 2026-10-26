// The switch of the performance trace of the host (docs/spec/performance-trace.md): the process holds it, the page turns it
// on and off, an observation is an event of the event log while it is on, and its markers are events too. No file holds the
// switch and no flag reaches a service.
package host_test

import (
	"errors"
	"os"
	"os/exec"
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

// The sampler and the surface events of the performance trace (docs/spec/performance-trace.md): the sampler reads the resident
// size of every process that the process registry names, and the surface lifecycle events hold the geometry.
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

// waitForFirstSample returns when the event log holds the first sample of the host that the sampler stored after the switch turned on.
func waitForFirstSample(t *testing.T, config string, log *host.EventLog) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for len(traceFields(t, config, log, "host.sampler.memory")) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the sampler stored no sample within 10 s of the switch")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// contract: performance.sampler.reads-every-registered-process
func TestTheSamplerReadsEveryRegisteredProcess(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	traceOn(t)
	// The sampler that the switch started stores its first sample at once; the check starts after it, so that a sample that began
	// before the removal below cannot be stored after it.
	waitForFirstSample(t, config, log)
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

// contract: performance.sampler.reads-every-window-process
func TestTheSamplerReadsTheProcessesOfEveryWindow(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	traceOn(t)
	// The sampler that the switch started stores its first sample at once; the check starts after it.
	waitForFirstSample(t, config, log)
	page := exec.Command("sleep", "30")
	document := exec.Command("sleep", "30")
	for _, child := range []*exec.Cmd{page, document} {
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	}
	host.PerformanceWindowAdd("window-a", func() (host.PerformanceWindowProcesses, error) {
		return host.PerformanceWindowProcesses{Page: page.Process.Pid, Documents: []host.PerformanceDocumentProcess{
			{Surface: "surface-a", Process: document.Process.Pid},
			{Surface: "surface-b", Process: 0},
		}, PluginHosts: []host.PerformancePluginHostProcess{
			{Plugin: "files", Process: page.Process.Pid},
			{Plugin: "editor", Process: 0},
		}}, nil
	})
	host.PerformanceWindowAdd("window-b", func() (host.PerformanceWindowProcesses, error) {
		return host.PerformanceWindowProcesses{}, errors.New("window facts unavailable")
	})
	t.Cleanup(func() { host.PerformanceWindowRemove("window-a"); host.PerformanceWindowRemove("window-b") })
	host.PerformanceSample()
	var pageFields, documentFields, notStarted, pluginHostFields, pluginHostNotStarted, unreadable map[string]any
	for _, fields := range traceFields(t, config, log, "host.sampler.memory") {
		switch {
		case fields["role"] == "page" && fields["window"] == "window-a":
			pageFields = fields
		case fields["role"] == "document" && fields["surface"] == "surface-a":
			documentFields = fields
		case fields["role"] == "document" && fields["surface"] == "surface-b":
			notStarted = fields
		case fields["role"] == "plugin-host" && fields["plugin"] == "files":
			pluginHostFields = fields
		case fields["role"] == "plugin-host" && fields["plugin"] == "editor":
			pluginHostNotStarted = fields
		case fields["role"] == "page" && fields["window"] == "window-b":
			unreadable = fields
		}
	}
	if pageFields == nil {
		t.Fatal("no page sample names window-a")
	}
	if pid, _ := pageFields["pid"].(float64); int(pid) != page.Process.Pid {
		t.Fatalf("the page sample names pid %v, want %d: %v", pageFields["pid"], page.Process.Pid, pageFields)
	}
	if size, _ := pageFields["rss_kb"].(float64); size <= 0 {
		t.Fatalf("the page sample holds no resident size: %v", pageFields)
	}
	if size, _ := pageFields["footprint_kb"].(float64); size <= 0 {
		t.Fatalf("the page sample holds no footprint: %v", pageFields)
	}
	if documentFields == nil {
		t.Fatal("no document sample names surface-a")
	}
	if pid, _ := documentFields["pid"].(float64); int(pid) != document.Process.Pid || documentFields["window"] != "window-a" {
		t.Fatalf("the document sample does not name window-a and pid %d: %v", document.Process.Pid, documentFields)
	}
	if size, _ := documentFields["footprint_kb"].(float64); size <= 0 {
		t.Fatalf("the document sample holds no footprint: %v", documentFields)
	}
	if pluginHostFields == nil || pluginHostFields["window"] != "window-a" || pluginHostFields["pid"] != float64(page.Process.Pid) {
		t.Fatalf("no plugin-host sample preserves its window, plugin, and shared pid: %v", pluginHostFields)
	}
	if size, _ := pluginHostFields["footprint_kb"].(float64); size <= 0 {
		t.Fatalf("the plugin-host sample holds no footprint: %v", pluginHostFields)
	}
	if pluginHostNotStarted == nil || pluginHostNotStarted["window"] != "window-a" ||
		pluginHostNotStarted["pid"] != float64(0) || pluginHostNotStarted["rss_kb"] != nil ||
		pluginHostNotStarted["footprint_kb"] != nil || pluginHostNotStarted["error"] == "" {
		t.Fatalf("an unstarted plugin host was not recorded explicitly: %v", pluginHostNotStarted)
	}
	if text, _ := notStarted["error"].(string); text == "" || notStarted["window"] != "window-a" {
		t.Fatalf("a web view whose process has not started has no error: %v", notStarted)
	}
	if _, ok := notStarted["rss_kb"]; ok {
		t.Fatalf("a web view whose process has not started was recorded as a size: %v", notStarted)
	}
	if text, _ := unreadable["error"].(string); text == "" {
		t.Fatalf("a window whose facts cannot be read has no error: %v", unreadable)
	}
}
