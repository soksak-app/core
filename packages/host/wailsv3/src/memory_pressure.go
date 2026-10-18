package host

// The relay of the memory pressure reports to the pages (docs/spec/hosts.md#memory-pressure).

import (
	"encoding/json"
	"errors"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// MemoryPressureSource is the operation of the platform that starts the memory pressure source of the process.
type MemoryPressureSource interface {
	OnMemoryPressure(report func(level string, seq uint64)) error
}

// StartMemoryPressure starts the source and sends each of its reports to the pages as the page event `memory-pressure` with
// `{level, seq}` through emit. The source reports on the UI thread, and emit may wait for a lock of the host, so the report only
// appends to a queue and one routine emits the queued reports in seq order: a page then ends with the level in force. The queue
// is unbounded and drops nothing, because the source reports only a change of level.
func StartMemoryPressure(source MemoryPressureSource, emit func(name string, payload any)) error {
	var mu sync.Mutex
	var queued []map[string]any
	ready := make(chan struct{}, 1)
	err := source.OnMemoryPressure(func(level string, seq uint64) {
		mu.Lock()
		queued = append(queued, map[string]any{"level": level, "seq": seq})
		mu.Unlock()
		select {
		case ready <- struct{}{}:
		default:
		}
	})
	if err != nil {
		return err
	}
	routine.Go("memory-pressure", func() {
		for range ready {
			mu.Lock()
			reports := queued
			queued = nil
			mu.Unlock()
			for _, report := range reports {
				emit("memory-pressure", report)
			}
		}
	})
	return nil
}

// ParseMemoryPressureLevel reads the level of a memory pressure report: `normal`, `warn` or `critical`.
func ParseMemoryPressureLevel(raw json.RawMessage) (string, error) {
	var level string
	if err := json.Unmarshal(raw, &level); err != nil || (level != "normal" && level != "warn" && level != "critical") {
		return "", errors.New("level must be normal, warn or critical")
	}
	return level, nil
}

// setupMemoryPressure starts the memory pressure source on the UI thread once the application started; each report goes to
// every window. A failure ends the start (docs/spec/hosts.md#process-lifecycle).
func setupMemoryPressure(host *Host) {
	application.Get().Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		application.InvokeSync(func() {
			if err := StartMemoryPressure(system, host.announceToWindows); err != nil {
				fatalError("memory pressure", err)
			}
		})
	})
}
