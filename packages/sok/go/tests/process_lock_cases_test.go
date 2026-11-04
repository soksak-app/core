package tests

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
)

// lockCase is one case of the process.lock table (docs/spec/cases/process-lock.json).
type lockCase struct {
	ID      string `json:"id"`
	Held    bool   `json:"held"`
	Content string `json:"content"`
	Pid     string `json:"pid"`
	Outcome string `json:"outcome"`
}

// lockCases reads the case table of docs/spec/cases, which no package owns.
func lockCases(t *testing.T) []lockCase {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "docs", "spec", "cases", "process-lock.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []lockCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the process lock case table holds no case")
	}
	return table.Cases
}

// lockPids are the values of $LIVE and $DEAD of the table: this test process, and a pid that is not running.
func lockPids() map[string]string {
	return map[string]string{"$LIVE": fmt.Sprint(os.Getpid()), "$DEAD": "2147483646"}
}

// contract: cli.plugin.lock-form-cases
func TestAWritingCommandReadsTheProcessLockCaseTable(t *testing.T) {
	pids := lockPids()
	for _, c := range lockCases(t) {
		t.Run(c.ID, func(t *testing.T) {
			config := t.TempDir()
			lock := filepath.Join(config, "process.lock")
			content := strings.NewReplacer("$LIVE", pids["$LIVE"], "$DEAD", pids["$DEAD"]).Replace(c.Content)
			if err := os.WriteFile(lock, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if c.Held {
				// The test holds the advisory lock as a live owner does; the lock is released when the case ends.
				owner, err := os.Open(lock)
				if err != nil {
					t.Fatal(err)
				}
				defer owner.Close()
				if err := syscall.Flock(int(owner.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
					t.Fatal(err)
				}
			}
			code, _, stderr := run("plugin", "enable", "probe", "--config-dir", config)
			owned := fmt.Sprintf("configuration directory %s is already owned", config)
			switch c.Outcome {
			case "refused-live":
				want := fmt.Sprintf("sok: %s by process %s\n", owned, strings.NewReplacer("$LIVE", pids["$LIVE"], "$DEAD", pids["$DEAD"]).Replace(c.Pid))
				if code != 1 || stderr != want {
					t.Fatalf("code %d stderr %q, want %q", code, stderr, want)
				}
			case "refused-held-invalid":
				want := fmt.Sprintf("sok: %s by a live process; process.lock is not the current form: %s\n", owned, content)
				if code != 1 || stderr != want {
					t.Fatalf("code %d stderr %q, want %q", code, stderr, want)
				}
			case "refused-held-empty":
				want := fmt.Sprintf("sok: %s by a live process\n", owned)
				if code != 1 || stderr != want {
					t.Fatalf("code %d stderr %q, want %q", code, stderr, want)
				}
			case "taken":
				if strings.Contains(stderr, "already owned") || strings.Contains(stderr, "process.lock") {
					t.Fatalf("the command refused a free lock: %q", stderr)
				}
				if _, err := os.Stat(lock); !os.IsNotExist(err) {
					t.Fatalf("the command did not release the lock it took: %v", err)
				}
			default:
				t.Fatalf("unknown outcome %q", c.Outcome)
			}
		})
	}
}
