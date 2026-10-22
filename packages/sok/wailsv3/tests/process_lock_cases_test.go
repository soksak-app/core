package tests

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// lockCase is one case of the process.lock form table (docs/spec/cases/process-lock.json).
type lockCase struct {
	ID      string `json:"id"`
	Content string `json:"content"`
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

// contract: cli.plugin.lock-form-cases
func TestAWritingCommandReadsTheProcessLockFormOfTheCaseTable(t *testing.T) {
	const deadPID = "2147483646"
	for _, c := range lockCases(t) {
		t.Run(c.ID, func(t *testing.T) {
			config := t.TempDir()
			lock := filepath.Join(config, "process.lock")
			content := strings.NewReplacer("$LIVE", fmt.Sprint(os.Getpid()), "$DEAD", deadPID).Replace(c.Content)
			if err := os.WriteFile(lock, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			code, _, stderr := run("plugin", "enable", "probe", "--config-dir", config)
			switch c.Outcome {
			case "refused-live":
				want := fmt.Sprintf("sok: configuration directory %s is already owned by process %d\n", config, os.Getpid())
				if code != 1 || stderr != want {
					t.Fatalf("code %d stderr %q, want %q", code, stderr, want)
				}
			case "refused-invalid":
				want := fmt.Sprintf("sok: %s: process.lock is not the current form: %s\n", lock, content)
				if code != 1 || stderr != want {
					t.Fatalf("code %d stderr %q, want %q", code, stderr, want)
				}
			case "taken":
				if strings.Contains(stderr, "already owned") || strings.Contains(stderr, "process.lock") {
					t.Fatalf("the command refused a lock that it should take: %q", stderr)
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
