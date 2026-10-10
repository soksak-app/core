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
	if err := emitTrace(layer, fields()); err != nil {
		LogError("performance trace", err)
	}
}

// Performance 는 페이지의 성능 요청을 처리한다.
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
	go func() {
		defer close(done)
		for {
			PerformanceObserve("sampler", func() map[string]any { return PerformanceMemory(os.Getpid()) })
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Second):
			}
		}
	}()
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

// PerformanceSamplerRunning reports whether the sampler of the trace runs.
func PerformanceSamplerRunning() bool {
	samplerMu.Lock()
	defer samplerMu.Unlock()
	return samplerStop != nil
}

// PerformanceMemory 는 sampler 가 기록하는 pid 의 메모리 사건이다.
// 읽기에 실패하면 크기 대신 그 오류를 기록한다.
func PerformanceMemory(pid int) map[string]any {
	size, err := residentKB(pid)
	if err != nil {
		return map[string]any{"event": "memory", "error": err.Error()}
	}
	return map[string]any{"event": "memory", "rss_host_kb": size}
}

// residentKB 는 pid 의 상주 크기(KB)다. ps 를 실행하지 못하거나 크기를 돌려주지 않으면(프로세스가 끝났으면) 오류다.
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
