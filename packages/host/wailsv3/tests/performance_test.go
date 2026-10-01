// 성능 트레이스 호스트 쪽 계약(docs/spec/performance-trace.md, V5-104).
// 켜기는 로그 파일과 사이드카 플래그 파일을 만들고, 끄기는 플래그를 지운다.
// 페이지 줄 중계는 객체 형식을 검증하고 대상에 덧붙인다.
package host_test

import (
	"encoding/json"
	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tempConfig(t *testing.T) string {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "services", "fixture-service"), 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

// contract: performance.trace.enable-writes-log-and-sidecar-flags
func TestEnableWritesTheLogAndTheSidecarFlags(t *testing.T) {
	config := tempConfig(t)
	target, err := host.PerformanceEnable(config)
	if err != nil {
		t.Fatal(err)
	}
	if target != filepath.Join(config, "logs", "performance.ndjson") {
		t.Fatalf("target %q", target)
	}
	flag, err := os.ReadFile(filepath.Join(config, "services", "fixture-service", "performance"))
	if err != nil {
		t.Fatal("every existing service directory receives the flag")
	}
	if strings.TrimSpace(string(flag)) != target {
		t.Fatalf("flag %q points elsewhere", flag)
	}
	if err := host.PerformanceLine(target, "host", map[string]any{"event": "trace_on"}); err != nil {
		t.Fatal(err)
	}
	text, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(text))), &record); err != nil {
		t.Fatalf("every line is one JSON object: %v", err)
	}
	if record["layer"] != "host" || record["event"] != "trace_on" {
		t.Fatalf("record %v", record)
	}
}

// contract: performance.trace.disable-removes-flags-keeps-log
func TestDisableRemovesTheFlagsButKeepsTheLog(t *testing.T) {
	config := tempConfig(t)
	target, err := host.PerformanceEnable(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.PerformanceLine(target, "host", map[string]any{"event": "trace_on"}); err != nil {
		t.Fatal(err)
	}
	if err := host.PerformanceDisable(config); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(config, "services", "fixture-service", "performance")); !os.IsNotExist(err) {
		t.Fatal("disable removes the flag")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("the log belongs to the trace, not the switch")
	}
}

// contract: performance.trace.relay-requires-object-with-event
func TestRelayedPageLinesRequireAnEvent(t *testing.T) {
	config := tempConfig(t)
	target, err := host.PerformanceEnable(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.PerformanceRelay(target, map[string]any{"event": "action", "kind": "resize"}); err != nil {
		t.Fatal(err)
	}
	text, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if count := strings.Count(strings.TrimSpace(string(text)), "\n") + 1; count != 1 {
		t.Fatalf("rejected lines append nothing, got %d lines", count)
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(text))), &record); err != nil {
		t.Fatal(err)
	}
	if record["layer"] != "page" || record["kind"] != "resize" {
		t.Fatalf("record %v", record)
	}
}

// contract: performance.trace.enable-without-services
func TestEnableWithoutServicesAcceptsPageEvents(t *testing.T) {
	config := t.TempDir()
	if _, err := host.PerformanceCommand(config, map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := host.PerformanceDisable(config); err != nil {
			t.Error(err)
		}
	})
	if _, err := host.PerformanceCommand(config, map[string]any{"action": "line", "line": map[string]any{"event": "focus"}}); err != nil {
		t.Fatalf("enabled trace rejected a page event without services: %v", err)
	}
}

// contract: performance.trace.already-off-writes-nothing
func TestAlreadyOffWritesNothing(t *testing.T) {
	config := tempConfig(t)
	if err := os.MkdirAll(filepath.Join(config, "logs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := host.PerformanceCommand(config, map[string]any{"action": "off"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(host.PerformanceTarget(config)); !os.IsNotExist(err) {
		t.Fatalf("disabled trace created output: %v", err)
	}
}

// contract: performance.trace.switch-and-relay-report-filesystem-errors
func TestSwitchAndRelayReportFilesystemErrors(t *testing.T) {
	t.Run("service-directory", func(t *testing.T) {
		config := t.TempDir()
		if err := os.WriteFile(filepath.Join(config, "services"), []byte("not a directory"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := host.PerformanceCommand(config, map[string]any{"action": "on"}); err == nil {
			t.Fatal("enable hid an invalid services directory")
		}
	})
	t.Run("service-flag", func(t *testing.T) {
		config := tempConfig(t)
		if err := os.Mkdir(filepath.Join(config, "services", "fixture-service", "performance"), 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := host.PerformanceCommand(config, map[string]any{"action": "on"}); err == nil {
			t.Fatal("enable hid a service flag write failure")
		}
	})
	t.Run("event-output", func(t *testing.T) {
		config := tempConfig(t)
		if _, err := host.PerformanceCommand(config, map[string]any{"action": "on"}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := host.PerformanceDisable(config); err != nil {
				t.Error(err)
			}
		})
		if err := os.Remove(host.PerformanceTarget(config)); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(host.PerformanceTarget(config), 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := host.PerformanceCommand(config, map[string]any{"action": "line", "line": map[string]any{"event": "focus"}}); err == nil {
			t.Fatal("relay hid an output write failure")
		}
	})
}

// contract: performance.trace.relay-requires-object-with-event
func TestRelayRejectsInvalidEventExplicitly(t *testing.T) {
	config := tempConfig(t)
	if _, err := host.PerformanceCommand(config, map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := host.PerformanceDisable(config); err != nil {
			t.Error(err)
		}
	})
	if _, err := host.PerformanceCommand(config, map[string]any{"action": "line", "line": map[string]any{"event": 7}}); err == nil {
		t.Fatal("relay accepted a non-string event")
	}
}

// contract: performance.trace.invalid-switch-and-cleanup-errors
func TestInvalidSwitchAndCleanupErrors(t *testing.T) {
	config := t.TempDir()
	if err := os.Mkdir(filepath.Join(config, "performance"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := host.PerformanceCommand(config, map[string]any{"action": "line", "line": map[string]any{"event": "focus"}}); err == nil || !strings.Contains(err.Error(), "performance switch") {
		t.Fatalf("invalid switch was hidden: %v", err)
	}
	if err := os.Remove(filepath.Join(config, "performance")); err != nil {
		t.Fatal(err)
	}
	flag := filepath.Join(config, "services", "fixture-service", "performance")
	if err := os.MkdirAll(flag, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := host.PerformanceDisable(config); err == nil {
		t.Fatal("disable removed an invalid flag directory instead of reporting it")
	}
	if stat, err := os.Stat(flag); err != nil || !stat.IsDir() {
		t.Fatalf("invalid flag directory was removed: %v", err)
	}
}

// contract: performance.trace.derive-service-flags-and-reset
func TestDeriveServiceFlagsAndReset(t *testing.T) {
	config := t.TempDir()
	if _, err := host.PerformanceCommand(config, map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	flag := filepath.Join(config, "services", "fixture-service", "performance")
	if err := os.MkdirAll(filepath.Dir(flag), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := host.PerformanceSyncServices(config); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(flag); err != nil || string(data) != host.PerformanceTarget(config)+"\n" {
		t.Fatalf("new service did not receive the active target: %q %v", data, err)
	}
	if err := host.PerformanceDisable(config); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{flag, filepath.Join(config, "performance")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("reset retained %s: %v", path, err)
		}
	}
	formatted := 0
	host.PerformanceObserve(config, "host", func() map[string]any { formatted++; return map[string]any{"event": "focus"} })
	if formatted != 0 {
		t.Fatalf("disabled observation formatted %d events", formatted)
	}
	if err := os.WriteFile(flag, []byte(host.PerformanceTarget(config)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := host.PerformanceSyncServices(config); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(flag); !os.IsNotExist(err) {
		t.Fatalf("disabled reattachment retained stale flag: %v", err)
	}
}

// contract: performance.sampler.failed-reading-is-explicit
func TestSamplerReportsAFailedReading(t *testing.T) {
	// 존재하지 않는 pid 의 상주 크기는 읽을 수 없다. 0 으로 바꾸지 않고 오류로 기록한다.
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

// contract: performance.trace.relay-records-writer-pid
func TestRelayedPageLineCarriesTheWriterPid(t *testing.T) {
	target := filepath.Join(t.TempDir(), "performance.ndjson")
	if err := host.PerformanceRelay(target, map[string]any{"ts": "2026-10-01T00:00:00.000Z", "event": "focus"}); err != nil {
		t.Fatal(err)
	}
	text, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err := json.Unmarshal(text, &record); err != nil {
		t.Fatal(err)
	}
	if pid, _ := record["pid"].(float64); int(pid) != os.Getpid() {
		t.Fatalf("a relayed page line does not name the writing process: %v", record)
	}
}

// contract: performance.trace.rotates-at-10mb
func TestTraceRotatesAtTenMegabytes(t *testing.T) {
	target := filepath.Join(t.TempDir(), "performance.ndjson")
	full := strings.Repeat("x", 10*1024*1024-1) + "\n"
	if err := os.WriteFile(target, []byte(full), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := host.PerformanceLine(target, "host", map[string]any{"event": "after"}); err != nil {
		t.Fatal(err)
	}
	previous, err := os.ReadFile(target + ".1")
	if err != nil || string(previous) != full {
		t.Fatalf("the full output was not kept as the previous generation: %v (%d bytes)", err, len(previous))
	}
	current, err := os.ReadFile(target)
	if err != nil || strings.Count(string(current), "\n") != 1 || !strings.Contains(string(current), `"event":"after"`) {
		t.Fatalf("the new line did not start a new output: %v %q", err, current)
	}
}
