// 성능 트레이스의 호스트 쪽(V5-104, docs/spec/performance-trace.md).
//
// 페이지가 host.performance 로 트레이스를 켜고 끈다. 켜면 호스트는 구성 디렉터리의
// logs/performance.ndjson 에 자기 줄을 남기고 이미 있는 모든 사이드카 서비스 디렉터리에
// 대상 경로를 담은 performance 플래그 파일을 쓴다 — 사이드카는 그 파일이 가리키는
// 대상에 직접 덧붙인다. 끄면 플래그 파일을 지운다. 로그 파일과 로테이션은 설정이 아니라
// 트레이스의 소유물이므로 끄고 재시작해도 로그는 남는다.
//
// 계기는 진단이다: 모든 쓰기 함수는 실패를 조용히 흡수한다. 트레이스가 실패해서
// 애플리케이션이 실패하는 일이 없어야 하기 때문이다.
package host

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// PerformanceTarget 은 구성 디렉터리가 가리키는 트레이스 대상이다.
func PerformanceTarget(config string) string {
	return filepath.Join(config, "logs", "performance.ndjson")
}

// PerformanceEnable 은 트레이스를 켠다. 로그 디렉터리를 만들고 서비스 디렉터리마다
// 플래그 파일을 쓴다.
func PerformanceEnable(config string) (string, error) {
	target := PerformanceTarget(config)
	if err := os.MkdirAll(filepath.Join(config, "logs"), 0o700); err != nil {
		return "", fmt.Errorf("create logs directory: %w", err)
	}
	performanceWriteFlags(config, target)
	return target, nil
}

// PerformanceDisable 은 트레이스를 끈다. 사이드카 플래그 파일을 지운다; 로그는 남는다.
func PerformanceDisable(config string) error {
	entries, err := os.ReadDir(filepath.Join(config, "services"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		flag := filepath.Join(servicesDir(config), entry.Name(), "performance")
		if err := os.Remove(flag); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove performance flag: %w", err)
		}
	}
	return nil
}

// PerformanceEnabled 는 트레이스가 켜져 있는가. 스위치의 상태는 사이드카 플래그 파일이다.
func PerformanceEnabled(config string) bool {
	entries, err := os.ReadDir(servicesDir(config))
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if _, err := os.Stat(filepath.Join(servicesDir(config), entry.Name(), "performance")); err == nil {
			return true
		}
	}
	return false
}

// PerformanceLine 은 한 계층의 줄을 대상에 남긴다. fields 는 문자열 event 를 담아야 한다.
// 쓰기 실패는 조용히 흡수한다.
func PerformanceLine(target, layer string, fields map[string]any) {
	event, ok := fields["event"].(string)
	if !ok {
		return
	}
	record := map[string]any{
		"ts":    performanceNow(),
		"pid":   os.Getpid(),
		"layer": layer,
		"event": event,
	}
	for key, value := range fields {
		if key != "event" {
			record[key] = value
		}
	}
	performanceAppend(target, record)
}

// PerformanceRelay 는 페이지가 보낸 줄을 중계한다. 객체이고 문자열 event 를 담았을 때만
// 대상에 덧붙인다. 계층은 호스트가 page 로 못박는다 — 페이지는 이 파일의 소유자가 아니다.
// 쓰기 실패는 조용히 흡수한다.
func PerformanceRelay(target string, record map[string]any) {
	if _, ok := record["event"].(string); !ok {
		return
	}
	record["layer"] = "page"
	performanceAppend(target, record)
}

// PerformanceCommand 는 페이지의 host.performance 요청을 처리한다.
func (h *Host) Performance(request map[string]any) (any, error) {
	action, _ := request["action"].(string) // 기본값: action 이 문자열이 아니면 switch 의 default 가 답한다
	target := PerformanceTarget(h.configDir)
	switch action {
	case "on":
		target, err := PerformanceEnable(h.configDir)
		if err != nil {
			return nil, err
		}
		PerformanceLine(target, "host", map[string]any{"event": "trace_on"})
		performanceSampler(h.configDir)
		return nil, nil
	case "off":
		PerformanceLine(target, "host", map[string]any{"event": "trace_off"})
		return nil, PerformanceDisable(h.configDir)
	case "line":
		record, _ := request["line"].(map[string]any) // 기본값: line 이 객체가 아니면 nil 로 아래에서 거부한다
		if record == nil {
			return nil, fmt.Errorf("line requires the page event object")
		}
		if !PerformanceEnabled(h.configDir) {
			return nil, fmt.Errorf("the performance trace is off")
		}
		PerformanceRelay(target, record)
		return nil, nil
	default:
		return nil, fmt.Errorf("action must be on, off, or line, not %q", action)
	}
}

func servicesDir(config string) string {
	return filepath.Join(config, "services")
}

func performanceWriteFlags(config, target string) {
	entries, err := os.ReadDir(servicesDir(config))
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		flag := filepath.Join(servicesDir(config), entry.Name(), "performance")
		if err := os.WriteFile(flag, []byte(target+"\n"), 0o600); err != nil {
			// 계기는 진단이다: 실패해도 앱이 계속 돈다.
		}
	}
}

func performanceAppend(target string, record map[string]any) {
	file, err := os.OpenFile(target, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	encoded, err := json.Marshal(record)
	if err != nil {
		return
	}
	if _, err := file.Write(append(encoded, '\n')); err != nil {
		// 계기는 진단이다: 실패해도 앱이 계속 돈다.
	}
}

// performanceSampler 는 메모리 샘플러(V5-104). 트레이스가 켜져 있는 동안 5초마다
// 이 프로세스의 상주 크기를 한 줄로 남긴다. 사이드카 pid 는 프로세스 등록부 줄에
// 쌓이므로 로그 소비자가 짝지는다. 꺼지면 대기로 돌아간다.
func performanceSampler(config string) {
	if !performanceSamplerOnce.CompareAndSwap(false, true) {
		return
	}
	go func() {
		for {
			if !PerformanceEnabled(config) {
				time.Sleep(5 * time.Second)
				continue
			}
			PerformanceLine(PerformanceTarget(config), "sampler", map[string]any{
				"event": "memory", "rss_host_kb": residentKB(os.Getpid()),
			})
			time.Sleep(5 * time.Second)
		}
	}()
}

var performanceSamplerOnce atomic.Bool

// residentKB 는 pid 의 상주 크기(KB). 실패는 0 — 프로세스가 끝났을 수 있다.
func residentKB(pid int) uint64 {
	out, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	value, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0
	}
	return value
}

func performanceNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// cleanupOrphanWebKit 은 이전 실행이 남긴 고아 WebKit XPC 프로세스를 죽인다(V5-105).
// WebKit XPC(WebContent·GPU·Networking)는 클라이언트가 죽어도 저절로 종료되지 않을 수 있다.
// 연결이 끊긴 XPC 는 unix 소켓이 없다. 시작 시 소켓이 없는 WebKit XPC 를 죽이면 이전
// 실행의 잔재가 사라진다. 살아 있는 다른 앱의 WebKit 은 소켓이 있어 죽지 않는다.
// 이 정리는 멱등이다: 고아가 없으면 아무 일도 일어나지 않는다.
func cleanupOrphanWebKit() {
	out, err := exec.Command("sh", "-c",
		`ps -axo pid,command | grep 'WebKit\.' | grep -v grep | awk '{print $1}'`).Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		pid, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil {
			continue
		}
		lsof, err := exec.Command("lsof", "-p", strconv.Itoa(pid)).Output()
		if err != nil {
			continue
		}
		if strings.Contains(string(lsof), "unix") {
			continue
		}
		log.Printf("performance: killing orphan WebKit XPC process %d", pid)
		if err := exec.Command("kill", strconv.Itoa(pid)).Run(); err != nil {
			log.Printf("performance: kill orphan %d: %v", pid, err)
		}
	}
}
