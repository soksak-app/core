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
	dir := filepath.Join(os.TempDir(), "wails-performance-", t.Name())
	os.RemoveAll(dir)
	if err := os.MkdirAll(filepath.Join(dir, "services", "soksak-vt-alacritty"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func TestEnableWritesTheLogAndTheSidecarFlags(t *testing.T) {
	config := tempConfig(t)
	target, err := host.PerformanceEnable(config)
	if err != nil {
		t.Fatal(err)
	}
	if target != filepath.Join(config, "logs", "performance.ndjson") {
		t.Fatalf("target %q", target)
	}
	flag, err := os.ReadFile(filepath.Join(config, "services", "soksak-vt-alacritty", "performance"))
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
	if _, err := os.Stat(filepath.Join(config, "services", "soksak-vt-alacritty", "performance")); !os.IsNotExist(err) {
		t.Fatal("disable removes the flag")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("the log belongs to the trace, not the switch")
	}
}

func TestRelayedPageLinesRequireAnEvent(t *testing.T) {
	config := tempConfig(t)
	target, err := host.PerformanceEnable(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.PerformanceRelay(target, map[string]any{"event": "action", "kind": "resize"}); err != nil {
		t.Fatal(err)
	}
	if err := host.PerformanceRelay(target, map[string]any{"kind": "resize"}); err == nil {
		t.Fatal("a line without a string event is rejected")
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
