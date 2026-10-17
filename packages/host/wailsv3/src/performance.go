// The switch and the sampler of the performance trace (docs/spec/performance-trace.md). The process holds the switch; an
// observation is an event of the event log while the switch is on. The page turns it on and off with the call `performance`.
package host

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

var (
	performanceOn atomic.Bool
	// performanceMu orders the requests of the page to switch the trace.
	performanceMu sync.Mutex
)

// PerformanceEnabled reports whether the trace of this process is on.
func PerformanceEnabled() bool { return performanceOn.Load() }

// PerformanceObserve builds and stores an observation only while the trace is on, as an event of the event log
// (`host.trace.<event>`, `host.sampler.<event>`), and reports an error. The measured operation goes on.
func PerformanceObserve(layer string, fields func() map[string]any) {
	if !performanceOn.Load() {
		return
	}
	// The observation is of the class call at the level debug: a policy that does not store it builds no fields.
	if !GateEvent(ClassCall, LevelDebug) {
		return
	}
	if err := emitTrace(layer, fields()); err != nil {
		LogError("performance trace", err)
	}
}

// Performance handles the performance requests of the page.
func (h *Host) Performance(requestJSON json.RawMessage) (any, error) {
	request, err := argument[map[string]any]("request", requestJSON)
	if err != nil {
		return nil, err
	}
	return PerformanceCommand(request)
}

// PerformanceCommand runs the switch requests of the page in the order they arrive. The events of the page travel through
// the call log (event_relay.go), not through this call. Turning the trace on stores the event `host.trace.on` and starts the
// sampler; turning it off stores `host.trace.off` before the switch goes off.
func PerformanceCommand(request map[string]any) (any, error) {
	action, ok := request["action"].(string)
	if !ok {
		return nil, fmt.Errorf("action must be on or off")
	}
	if action != "on" && action != "off" {
		return nil, fmt.Errorf("action must be on or off, not %q", action)
	}
	performanceMu.Lock()
	defer performanceMu.Unlock()
	switch action {
	case "on":
		if performanceOn.Swap(true) {
			return nil, nil
		}
		PerformanceObserve("host", func() map[string]any { return map[string]any{"event": "on"} })
		performanceSamplerStart()
	case "off":
		if !performanceOn.Load() {
			return nil, nil
		}
		PerformanceObserve("host", func() map[string]any { return map[string]any{"event": "off"} })
		performanceOn.Store(false)
		performanceSamplerEnd()
	}
	return nil, nil
}

// The sampler stores the resident size of the host every 5 seconds while the trace is on. It ends with the switch: turning
// the trace off waits until the goroutine returned, and turning it on again starts a new one.
var (
	samplerMu   sync.Mutex
	samplerStop chan struct{}
	samplerDone chan struct{}
)

func performanceSamplerStart() {
	samplerMu.Lock()
	defer samplerMu.Unlock()
	if samplerStop != nil {
		return
	}
	stop, done := make(chan struct{}), make(chan struct{})
	samplerStop, samplerDone = stop, done
	routine.Go("performance-sampler", func() {
		defer close(done)
		for {
			PerformanceSample()
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Second):
			}
		}
	})
}

func performanceSamplerEnd() {
	samplerMu.Lock()
	defer samplerMu.Unlock()
	if samplerStop == nil {
		return
	}
	close(samplerStop)
	<-samplerDone
	samplerStop, samplerDone = nil, nil
}

// processes is the process registry: every sidecar process the host started or connected to, by pid, with the role and the
// name that make a memory reading attribute itself. A process leaves the registry when it ends or its connection ends.
var (
	processesMu sync.Mutex
	processes   = map[int]registeredProcess{}
)

type registeredProcess struct{ role, name string }

// PerformanceProcessAdd names a process for the sampler and stores the event `process` with its role, name and pid, so the
// samples attribute themselves. Naming a pid again replaces its role and name.
func PerformanceProcessAdd(role, name string, pid int) {
	processesMu.Lock()
	processes[pid] = registeredProcess{role: role, name: name}
	processesMu.Unlock()
	PerformanceObserve("host", func() map[string]any {
		return map[string]any{"event": "process", "role": role, "name": name, "pid": pid}
	})
}

// PerformanceProcessRemove removes a process from the registry; a pid that is not named is ignored because both the end of
// a process and the end of its connection remove it.
func PerformanceProcessRemove(pid int) {
	processesMu.Lock()
	delete(processes, pid)
	processesMu.Unlock()
}

// PerformanceSample stores the memory of the host, of every registered process, and of the processes of every open window, each as
// one event `host.sampler.memory`. A reading that fails is stored with its error instead of the sizes.
func PerformanceSample() {
	PerformanceObserve("sampler", func() map[string]any { return PerformanceMemory(os.Getpid()) })
	processesMu.Lock()
	named := make(map[int]registeredProcess, len(processes))
	for pid, process := range processes {
		named[pid] = process
	}
	processesMu.Unlock()
	for pid, process := range named {
		PerformanceObserve("sampler", func() map[string]any {
			return processMemory(map[string]any{"role": process.role, "name": process.name}, pid)
		})
	}
	performanceWindowsMu.Lock()
	windows := make(map[string]PerformanceWindowReader, len(performanceWindows))
	for window, read := range performanceWindows {
		windows[window] = read
	}
	performanceWindowsMu.Unlock()
	for window, read := range windows {
		processes, err := read()
		if err != nil {
			PerformanceObserve("sampler", func() map[string]any {
				return map[string]any{"event": "memory", "role": "page", "window": window, "error": err.Error()}
			})
			continue
		}
		PerformanceObserve("sampler", func() map[string]any {
			return processMemory(map[string]any{"role": "page", "window": window}, processes.Page)
		})
		for _, document := range processes.Documents {
			PerformanceObserve("sampler", func() map[string]any {
				return processMemory(map[string]any{"role": "document", "window": window, "surface": document.Surface}, document.Process)
			})
		}
	}
}

// processMemory adds the memory of pid to record: rss_kb and footprint_kb, or error when a reading fails. Pid 0 is a web view whose
// WebContent process has not started, so no process can be read for it and its error says so.
func processMemory(record map[string]any, pid int) map[string]any {
	record["event"] = "memory"
	record["pid"] = pid
	if pid <= 0 {
		record["error"] = fmt.Sprintf("the web process has not started (pid %d)", pid)
		return record
	}
	size, err := residentKB(pid)
	if err != nil {
		record["error"] = err.Error()
		return record
	}
	footprint, err := processFootprintKB(pid)
	if err != nil {
		record["error"] = err.Error()
		return record
	}
	record["rss_kb"], record["footprint_kb"] = size, footprint
	return record
}

// processFootprintKB is the physical footprint (KB) of pid, read through the registered platform implementation. The platform
// tests and the host both register it at package initialization, so an unregistered platform is an error.
func processFootprintKB(pid int) (uint64, error) {
	current, err := platform.Current()
	if err != nil {
		return 0, err
	}
	return current.ProcessFootprintKB(pid)
}

// PerformanceWindowProcesses are the processes of one window that the sampler reads: the WebContent process of its page and
// of each document web view, with the surface of that document. A process is 0 before it starts.
type PerformanceWindowProcesses struct {
	Page      int
	Documents []PerformanceDocumentProcess
}

// PerformanceDocumentProcess is the WebContent process of one document web view of a window.
type PerformanceDocumentProcess struct {
	Surface string
	Process int
}

// PerformanceWindowReader reads the processes of a window. The sampler calls it on its own goroutine, not on the UI thread.
type PerformanceWindowReader func() (PerformanceWindowProcesses, error)

// performanceWindows is the window registry of the sampler: every open window by name, with the reader of its processes.
var (
	performanceWindowsMu sync.Mutex
	performanceWindows   = map[string]PerformanceWindowReader{}
)

// PerformanceWindowAdd names a window for the sampler, which reads its processes at each sample. Naming a window again replaces its reader.
func PerformanceWindowAdd(window string, read PerformanceWindowReader) {
	performanceWindowsMu.Lock()
	performanceWindows[window] = read
	performanceWindowsMu.Unlock()
}

// PerformanceWindowRemove removes a window from the registry when it closes; a name that is not registered is ignored.
func PerformanceWindowRemove(window string) {
	performanceWindowsMu.Lock()
	delete(performanceWindows, window)
	performanceWindowsMu.Unlock()
}

// PerformanceSurface stores a phase of the life of a surface (`created`, `placed`, `destroyed`) as the event `surface` of
// the trace. A placement adds the frame the host gave the native view and whether the view is visible.
func PerformanceSurface(phase, surface string, placement *Placement) {
	PerformanceObserve("host", func() map[string]any {
		record := map[string]any{"event": "surface", "phase": phase, "surface": surface}
		if placement != nil {
			record["x"], record["y"], record["w"], record["h"] = placement.X, placement.Y, placement.W, placement.H
			record["visible"] = placement.Visible
		}
		return record
	})
}

// PerformanceSamplerRunning reports whether the sampler of the trace runs.
func PerformanceSamplerRunning() bool {
	samplerMu.Lock()
	defer samplerMu.Unlock()
	return samplerStop != nil
}

// PerformanceMemory is the memory event of pid that the sampler records.
// When the read fails, it records that error instead of a size.
func PerformanceMemory(pid int) map[string]any {
	size, err := residentKB(pid)
	if err != nil {
		return map[string]any{"event": "memory", "error": err.Error()}
	}
	footprint, err := processFootprintKB(pid)
	if err != nil {
		return map[string]any{"event": "memory", "error": err.Error()}
	}
	return map[string]any{"event": "memory", "rss_host_kb": size, "footprint_kb": footprint}
}

// residentKB is the resident size (KB) of pid. It is an error when ps cannot be run or returns no size (the process ended).
func residentKB(pid int) (uint64, error) {
	out, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, fmt.Errorf("ps for pid %d: %w", pid, err)
	}
	value, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("ps reported no resident size for pid %d: %w", pid, err)
	}
	return value, nil
}
