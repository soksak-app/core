// Package host: the record of the WebKit XPC children that this run created and the harvest at the next start (V5-113).
//
// The start cleanup of V5-105 was removed because it could not tell processes apart (even a live WebKit has no socket or path proof).
// The rule here follows a known precedent: a singleton lock file records hostname-PID in the application's own user data
// directory and trusts only its own record. This run also records the pid of the WebKit children that it created in its own configuration directory,
// and the next start harvests only that record. A process that is not recorded is
// never touched.
//
// All of these conditions must hold to kill: it was recorded (we created it), that pid is still a WebKit process
// (protection against pid reuse), the start time equals the record (the same instance), and the host process that recorded it died (it is not a child
// of a live sibling instance).

package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// recordName is the file name of the record. It is placed at the root of the configuration directory.
const recordName = "webkit-children.json"

var (
	baselineOnce sync.Once
	baseline     map[int]bool // The WebKit XPC processes that were already running when this run started; they belong to others.
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

// psQuery runs ps with args and returns the standard output. In a query for one pid (-p), when that process does not exist, ps ends without output
// with status 1, and that is not a failure but the answer "that process does not exist". Any other failure is an error that carries the query and the message of ps,
// and the caller records it.
func psQuery(args ...string) (string, error) {
	out, err := exec.Command("ps", args...).Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if exit.ExitCode() == 1 && len(strings.TrimSpace(string(out))) == 0 && slices.Contains(args, "-p") {
			return "", nil
		}
		return "", fmt.Errorf("ps %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(exit.Stderr)))
	}
	if err != nil {
		return "", fmt.Errorf("ps %s: %w", strings.Join(args, " "), err)
	}
	return string(out), nil
}

// psFailed records a failed ps query. When the query has no answer, the caller decides not to kill rather than to kill.
func psFailed(err error) {
	LogError("webkit children", err)
}

// webkitProcesses returns the pids and kinds of the live WebKit XPC processes. When ps fails, it records that error and returns an empty set.
func webkitProcesses() map[int]string {
	out, err := psQuery("-axo", "pid=,command=")
	if err != nil {
		psFailed(err)
		return map[int]string{}
	}
	found, unreadable := ParseWebKitProcesses(out)
	for _, line := range unreadable {
		LogError("webkit children", fmt.Sprintf("ps line %q begins with no process number", line))
	}
	return found
}

// ParseWebKitProcesses returns the pids and kinds of the WebKit XPC processes in the output of `ps -axo pid=,command=`, and
// the lines that begin with no process number. ps pads the process number with leading spaces.
func ParseWebKitProcesses(out string) (map[int]string, []string) {
	found := map[int]string{}
	var unreadable []string
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || len(fields) < 2 {
			unreadable = append(unreadable, strings.TrimSpace(line))
			continue
		}
		command := strings.Join(fields[1:], " ")
		for _, kind := range []string{"WebContent", "GPU", "Networking"} {
			if strings.Contains(command, "com.apple.WebKit."+kind) {
				found[pid] = kind
			}
		}
	}
	return found, unreadable
}

// processExists asks with ps whether the process pid is alive (no signal is used). When ps fails, it records the failure and answers that the process does not exist.
func processExists(pid int) bool {
	out, err := psQuery("-o", "pid=", "-p", strconv.Itoa(pid))
	if err != nil {
		psFailed(err)
		return false
	}
	return strings.TrimSpace(out) != ""
}

// processStartTime returns the start time of the process pid. It is an empty string when there is none. When ps fails, it records the failure and returns an empty string.
func processStartTime(pid int) string {
	out, err := psQuery("-o", "lstart=", "-p", strconv.Itoa(pid))
	if err != nil {
		psFailed(err)
		return ""
	}
	return strings.TrimSpace(out)
}

// processCommand returns the command line of the process pid. It is an empty string when there is none. When ps fails, it records the failure and returns an empty string.
func processCommand(pid int) string {
	out, err := psQuery("-o", "command=", "-p", strconv.Itoa(pid))
	if err != nil {
		psFailed(err)
		return ""
	}
	return strings.TrimSpace(out)
}

// SnapshotBaseline takes the WebKit XPC processes at the start as the baseline. It is valid only once, before this run creates
// any WebKit. A process in the baseline belongs to others.
func SnapshotBaseline() {
	baselineOnce.Do(func() {
		baseline = map[int]bool{}
		for pid := range webkitProcesses() {
			baseline[pid] = true
		}
	})
}

// RefreshWebKitChildren records the WebKit children of this run. Call it at every page load. When WebKit replaces a
// dead child, the page opens again, so the record follows the replacement. It writes only when the set of children changed
// (atomic replacement).
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
	bytes, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		LogError("webkit children record", err)
		return
	}
	if err := WriteWebKitRecord(target, bytes); err != nil {
		LogError("webkit children record", err)
	}
}

// recordWrites runs the record writes one at a time. Page load notifications arrive in a different goroutine for each window, so if two writes
// wrote the same .new file, the write that renamed first would take the file of the other write and the remaining rename would fail (F68).
var recordWrites sync.Mutex

// WriteWebKitRecord atomically replaces the record file target with bytes. It writes to the adjacent .new file and renames it.
func WriteWebKitRecord(target string, bytes []byte) error {
	recordWrites.Lock()
	defer recordWrites.Unlock()
	system, err := platform.Current()
	if err != nil {
		return err
	}
	temporary := target + ".new"
	if err := system.WritePrivateFile(temporary, bytes); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	if err := os.Rename(temporary, target); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

func recordPath(config string) string {
	return config + "/" + recordName
}

// ReapRecordedWebKit harvests the WebKit children that the previous run recorded. Call it once before this run creates any WebKit.
// When any condition for killing does not hold, that entry is not touched.
func ReapRecordedWebKit(config string) {
	bytes, err := os.ReadFile(recordPath(config))
	if err != nil {
		return // When there is no record, there is nothing to harvest.
	}
	var record webkitRecord
	if err := json.Unmarshal(bytes, &record); err != nil {
		LogError("webkit children record", fmt.Sprintf("the record is invalid: %v", err))
		return
	}
	if record.HostPid == os.Getpid() {
		return // This is our record; the page load of this run writes it again.
	}
	if processExists(record.HostPid) && strings.Contains(processCommand(record.HostPid), "soksak") {
		// This is a child of a live sibling instance.
		LogInfo("webkit children", fmt.Sprintf("host %d still owns its recorded children; not reaping", record.HostPid))
		return
	}
	now := webkitProcesses()
	for _, child := range record.Children {
		if reason := ReapDecision(processExists(child.Pid), now[child.Pid] != "", processStartTime(child.Pid) == child.Lstart); reason != "" {
			LogInfo("webkit children", fmt.Sprintf("pid %d: %s", child.Pid, reason))
			continue
		}
		if out, err := exec.Command("kill", "-9", strconv.Itoa(child.Pid)).Output(); err != nil {
			LogError("webkit children", fmt.Sprintf("kill %d: %v: %s", child.Pid, err, strings.TrimSpace(string(out))))
		} else {
			LogInfo("webkit children", fmt.Sprintf("reaped orphaned %s pid %d left by host %d", child.Kind, child.Pid, record.HostPid))
		}
	}
}

// ReapDecision is the harvest decision for one recorded child. When the reason is an empty string, it is killed. The caller obtains the observation of the three
// conditions; the decision itself is pure, so the contract check handles it mechanically.
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
