// 성능 트레이스의 호스트 스위치와 기록기(docs/spec/performance-trace.md).
// 스위치·중계 오류는 호출자에게 반환하고, 수동 계측 오류는 stderr 에 보고한다.
package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// PerformanceTarget 은 구성 디렉터리가 가리키는 트레이스 대상이다.
func PerformanceTarget(config string) string {
	return filepath.Join(config, "logs", "performance.ndjson")
}

// PerformanceEnable 은 서비스 플래그를 쓴 뒤 호스트 실행 스위치를 켠다.
func PerformanceEnable(config string) (string, error) {
	target := PerformanceTarget(config)
	if err := os.MkdirAll(filepath.Join(config, "logs"), 0o700); err != nil {
		return "", fmt.Errorf("create logs directory: %w", err)
	}
	if err := performanceWriteFlags(config, target); err != nil {
		return "", errors.Join(err, PerformanceDisable(config))
	}
	if err := os.WriteFile(filepath.Join(config, "performance"), []byte(target+"\n"), 0o600); err != nil {
		return "", errors.Join(fmt.Errorf("write performance switch: %w", err), PerformanceDisable(config))
	}
	return target, nil
}

// PerformanceDisable 은 실행·서비스 플래그를 지우고 모든 정리 오류를 반환한다.
func PerformanceDisable(config string) error {
	var failures []error
	if err := performanceRemoveFlag(filepath.Join(config, "performance")); err != nil {
		failures = append(failures, fmt.Errorf("remove performance switch: %w", err))
	}
	entries, err := os.ReadDir(servicesDir(config))
	if err != nil {
		if !os.IsNotExist(err) {
			failures = append(failures, fmt.Errorf("read performance services: %w", err))
		}
		return errors.Join(failures...)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		flag := filepath.Join(servicesDir(config), entry.Name(), "performance")
		if err := performanceRemoveFlag(flag); err != nil {
			failures = append(failures, fmt.Errorf("remove performance flag %s: %w", flag, err))
		}
	}
	return errors.Join(failures...)
}

func performanceRemoveFlag(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("%s is a directory", path)
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// PerformanceEnabled 는 호스트 실행 플래그를 읽는다. 읽기·내용 오류는 상태로 바꾸지 않는다.
func PerformanceEnabled(config string) (bool, error) {
	data, err := os.ReadFile(filepath.Join(config, "performance"))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read performance switch: %w", err)
	}
	if string(data) != PerformanceTarget(config)+"\n" {
		return false, fmt.Errorf("invalid performance switch in %s", config)
	}
	return true, nil
}

var performanceMu sync.Mutex

// PerformanceObserve 는 활성 계측만 구성·기록하고 오류를 보고한다. 측정한 동작은 그대로 진행한다.
func PerformanceObserve(config, layer string, fields func() map[string]any) {
	performanceMu.Lock()
	defer performanceMu.Unlock()
	enabled, err := PerformanceEnabled(config)
	if err != nil {
		logPerformanceError(err)
		return
	}
	if !enabled {
		return
	}
	if err := PerformanceLine(PerformanceTarget(config), layer, fields()); err != nil {
		logPerformanceError(err)
	}
}

func logPerformanceError(err error) { fmt.Fprintln(os.Stderr, "performance trace failed:", err) }

// PerformanceSyncServices 는 서비스 생성·재접속 전에 유효 실행 스위치를 전파한다.
func PerformanceSyncServices(config string) error {
	performanceMu.Lock()
	defer performanceMu.Unlock()
	enabled, err := PerformanceEnabled(config)
	if err != nil {
		return err
	}
	if enabled {
		return performanceWriteFlags(config, PerformanceTarget(config))
	}
	return PerformanceDisable(config)
}

// PerformanceLine 은 한 계층의 이벤트를 기록하고 잘못된 이벤트·쓰기 실패를 반환한다.
func PerformanceLine(target, layer string, fields map[string]any) error {
	event, ok := fields["event"].(string)
	if !ok {
		return fmt.Errorf("event must be a string")
	}
	record := map[string]any{"ts": performanceNow(), "pid": os.Getpid(), "layer": layer, "event": event}
	for key, value := range fields {
		if key != "event" {
			record[key] = value
		}
	}
	return performanceAppend(target, record)
}

// PerformanceRelay 는 페이지 이벤트의 계층을 지정하여 기록하고 거부·쓰기 실패를 반환한다.
func PerformanceRelay(target string, record map[string]any) error {
	if _, ok := record["event"].(string); !ok {
		return fmt.Errorf("event must be a string")
	}
	record["layer"] = "page"
	// 이 줄을 파일에 쓰는 프로세스는 호스트다.
	record["pid"] = os.Getpid()
	return performanceAppend(target, record)
}

// Performance 는 페이지의 성능 요청을 처리한다.
func (h *Host) Performance(requestJSON json.RawMessage) (any, error) {
	request, err := argument[map[string]any]("request", requestJSON)
	if err != nil {
		return nil, err
	}
	return PerformanceCommand(h.configDir, request)
}

// PerformanceCommand 는 스위치와 중계를 같은 순서로 실행한다.
func PerformanceCommand(config string, request map[string]any) (any, error) {
	action, ok := request["action"].(string)
	if !ok {
		return nil, fmt.Errorf("action must be on, off, or line")
	}
	if action != "on" && action != "off" && action != "line" {
		return nil, fmt.Errorf("action must be on, off, or line, not %q", action)
	}
	performanceMu.Lock()
	defer performanceMu.Unlock()
	enabled, err := PerformanceEnabled(config)
	if err != nil {
		return nil, err
	}
	target := PerformanceTarget(config)
	switch action {
	case "on":
		if enabled {
			return nil, nil
		}
		target, err := PerformanceEnable(config)
		if err != nil {
			return nil, err
		}
		if err := PerformanceLine(target, "host", map[string]any{"event": "trace_on"}); err != nil {
			return nil, errors.Join(err, PerformanceDisable(config))
		}
		performanceSampler(config)
		return nil, nil
	case "off":
		var writeErr error
		if enabled {
			writeErr = PerformanceLine(target, "host", map[string]any{"event": "trace_off"})
		}
		return nil, errors.Join(writeErr, PerformanceDisable(config))
	case "line":
		record, ok := request["line"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("line requires the page event object")
		}
		if !enabled {
			return nil, fmt.Errorf("the performance trace is off")
		}
		return nil, PerformanceRelay(target, record)
	}
	panic("validated performance action is unreachable")
}

func servicesDir(config string) string { return filepath.Join(config, "services") }

func performanceWriteFlags(config, target string) error {
	entries, err := os.ReadDir(servicesDir(config))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read performance services: %w", err)
	}
	var failures []error
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		flag := filepath.Join(servicesDir(config), entry.Name(), "performance")
		if err := os.WriteFile(flag, []byte(target+"\n"), 0o600); err != nil {
			failures = append(failures, fmt.Errorf("write performance flag %s: %w", flag, err))
		}
	}
	return errors.Join(failures...)
}

// performanceRotateBytes 는 출력이 이전 세대로 넘어가는 크기다(docs/spec/performance-trace.md).
const performanceRotateBytes = 10 * 1024 * 1024

func performanceAppend(target string, record map[string]any) error {
	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode performance event: %w", err)
	}
	// 10 MB 에 이른 출력은 이전 세대(.1) 하나로 남기고 새 파일에 쓴다.
	if info, err := os.Stat(target); err == nil && info.Size() >= performanceRotateBytes {
		if err := os.Rename(target, target+".1"); err != nil {
			return fmt.Errorf("rotate performance output %s: %w", target, err)
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect performance output %s: %w", target, err)
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open performance output %s: %w", target, err)
	}
	_, writeErr := file.Write(append(encoded, '\n'))
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return fmt.Errorf("append performance output %s: %w", target, err)
	}
	return nil
}

// performanceSampler 는 활성 트레이스의 호스트 상주 크기를 5초마다 기록한다.
func performanceSampler(config string) {
	if !performanceSamplerOnce.CompareAndSwap(false, true) {
		return
	}
	go func() {
		for {
			PerformanceObserve(config, "sampler", func() map[string]any { return PerformanceMemory(os.Getpid()) })
			time.Sleep(5 * time.Second)
		}
	}()
}

var performanceSamplerOnce atomic.Bool

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

func performanceNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00") }
