// Package host — 이 실행이 만든 WebKit XPC 자식의 기록과 다음 시작의 수확(V5-113).
//
// 밤샘 V5-105의 시작 정리는 판별이 불가능해(살아 있는 WebKit 도 소켓·경로 증명이 없다)
// 제거되었다. 여기의 규칙은 선례를 따른다 — Chromium 의 SingletonLock 은 자기 사용자 데이터
// 디렉터리에 hostname-PID 를 기록하고 자기 기록만 신뢰한다. 이 실행도 자기 설정 디렉터리에
// 자기가 만든 WebKit 자식의 pid 를 기록하고, 다음 시작이 그 기록만 수확한다. 기록되지 않은
// 프로세스는 무조건 불가침이다.
//
// 죽일 수 있는 조건은 모두다: 기록되었고(우리가 만들었다), 지금도 그 pid 가 WebKit 프로세스이며
// (재활용 방어), 시작 시각이 기록과 같고(같은 인스턴스), 기록한 호스트 프로세스가 죽었다(살아
// 있는 형제 인스턴스의 자식이 아니다).

package host

import (
	"encoding/json"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

// recordName 은 기록 파일 이름이다. 설정 디렉터리의 뿌리에 둔다.
const recordName = "webkit-children.json"

var (
	baselineOnce sync.Once
	baseline     map[int]bool // 이 실행이 시작할 때 이미 떠 있던 WebKit XPC — 남의 것이다.
)

type childRecord struct {
	Pid    int    `json:"pid"`
	Kind   string `json:"kind"`
	Lstart string `json:"lstart"`
}

type webkitRecord struct {
	HostPid  int           `json:"host_pid"`
	Children []childRecord `json:"children"`
}

// webkitProcesses 는 살아 있는 WebKit XPC 의 pid 과 종류를 돌려준다.
func webkitProcesses() map[int]string {
	out, err := exec.Command("ps", "-axo", "pid=,command=").Output()
	if err != nil {
		return map[int]string{}
	}
	found := map[int]string{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		command := strings.Join(fields[1:], " ")
		for _, kind := range []string{"WebContent", "GPU", "Networking"} {
			if strings.Contains(command, "com.apple.WebKit."+kind) {
				found[pid] = kind
			}
		}
	}
	return found
}

// processExists 는 pid 프로세스가 살아 있는지 ps 로 묻는다(시그널을 쓰지 않는다).
func processExists(pid int) bool {
	out, err := exec.Command("ps", "-o", "pid=", "-p", strconv.Itoa(pid)).Output()
	return err == nil && strings.TrimSpace(string(out)) != ""
}

// processStartTime 은 pid 프로세스의 시작 시각을 돌려준다. 없으면 빈 문자열.
func processStartTime(pid int) string {
	out, err := exec.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// processCommand 는 pid 프로세스의 명령줄을 돌려준다. 없으면 빈 문자열.
func processCommand(pid int) string {
	out, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// SnapshotBaseline 은 시작 시점의 WebKit XPC 를 기준선으로 찍는다. 이 실행이 WebKit 을 만들기
// 전에 한 번만 유효하다. 기준선에 든 프로세스는 남의 것이다.
func SnapshotBaseline() {
	baselineOnce.Do(func() {
		baseline = map[int]bool{}
		for pid := range webkitProcesses() {
			baseline[pid] = true
		}
	})
}

// RefreshWebKitChildren 은 이 실행의 WebKit 자식을 기록한다. 페이지 적재마다 부른다 — WebKit 이
// 죽은 자식을 교체하면 페이지가 다시 뜨므로 기록이 교체를 따라간다. 자식 집합이 바뀌었을 때만
// 쓴다(원자적 교체).
func RefreshWebKitChildren(config string) {
	if baseline == nil {
		return
	}
	current := map[int]string{}
	for pid, kind := range webkitProcesses() {
		if !baseline[pid] {
			current[pid] = kind
		}
	}
	pids := make([]int, 0, len(current))
	for pid := range current {
		pids = append(pids, pid)
	}
	sortInts(pids)
	children := make([]childRecord, 0, len(pids))
	for _, pid := range pids {
		children = append(children, childRecord{Pid: pid, Kind: current[pid], Lstart: processStartTime(pid)})
	}
	record := webkitRecord{HostPid: os.Getpid(), Children: children}
	target := recordPath(config)
	if previous, err := os.ReadFile(target); err == nil {
		var previousRecord webkitRecord
		if json.Unmarshal(previous, &previousRecord) == nil {
			same := len(previousRecord.Children) == len(record.Children)
			for index := range record.Children {
				if index < len(previousRecord.Children) && previousRecord.Children[index].Pid != record.Children[index].Pid {
					same = false
				}
			}
			if same {
				return
			}
		}
	}
	temporary := target + ".new"
	bytes, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		log.Printf("webkit children record: %v", err)
		return
	}
	if err := os.WriteFile(temporary, bytes, 0o600); err != nil {
		log.Printf("webkit children record: write: %v", err)
		return
	}
	if err := os.Rename(temporary, target); err != nil {
		log.Printf("webkit children record: rename: %v", err)
	}
}

func recordPath(config string) string {
	return config + "/" + recordName
}

// ReapRecordedWebKit 는 지난 실행이 기록한 WebKit 자식을 수확한다. 이 실행이 WebKit 을 만들기 전에
// 한 번 부른다. 죽일 조건이 하나라도 성립하지 않으면 그 항목은 건드리지 않는다.
func ReapRecordedWebKit(config string) {
	bytes, err := os.ReadFile(recordPath(config))
	if err != nil {
		return // 기록이 없으면 수확할 것도 없다.
	}
	var record webkitRecord
	if err := json.Unmarshal(bytes, &record); err != nil {
		log.Printf("webkit children record is invalid: %v", err)
		return
	}
	if record.HostPid == os.Getpid() {
		return // 우리 기록이다 — 이 실행의 페이지 적재가 다시 쓴다.
	}
	if processExists(record.HostPid) && strings.Contains(processCommand(record.HostPid), "soksak") {
		// 살아 있는 형제 인스턴스의 자식이다.
		log.Printf("webkit children: host %d still owns its recorded children; not reaping", record.HostPid)
		return
	}
	now := webkitProcesses()
	for _, child := range record.Children {
		if reason := ReapDecision(processExists(child.Pid), now[child.Pid] != "", processStartTime(child.Pid) == child.Lstart); reason != "" {
			log.Printf("webkit children: pid %d: %s", child.Pid, reason)
			continue
		}
		if out, err := exec.Command("kill", "-9", strconv.Itoa(child.Pid)).Output(); err != nil {
			log.Printf("webkit children: kill %d: %v: %s", child.Pid, err, strings.TrimSpace(string(out)))
		} else {
			log.Printf("webkit children: reaped orphaned %s pid %d left by host %d", child.Kind, child.Pid, record.HostPid)
		}
	}
}

// ReapDecision 은 기록된 자식 하나의 수확 판정이다. 이유가 빈 문자열이면 죽인다. 셋의 관측은
// 호출자가 얻는다 — 판정 자체는 순수해서 계약 검사가 기계적으로 다룬다.
func ReapDecision(alive, isWebKit, sameStart bool) (reason string) {
	if !alive {
		return "already dead; nothing to reap"
	}
	if !isWebKit {
		return "no longer a WebKit process (recycled?); not killing"
	}
	if !sameStart {
		return "start time differs from the record; not killing"
	}
	return ""
}

func sortInts(values []int) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j-1] > values[j]; j-- {
			values[j-1], values[j] = values[j], values[j-1]
		}
	}
}
