package host_test

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// lockCase is one case of the process.lock table that a live owner holds (docs/spec/cases/process-lock.json).
type lockCase struct {
	ID      string `json:"id"`
	Held    bool   `json:"held"`
	Content string `json:"content"`
	Pid     string `json:"pid"`
	Outcome string `json:"outcome"`
}

// heldLockCases reads the held cases of the case table of docs/spec/cases, which no package owns.
func heldLockCases(t *testing.T) []lockCase {
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
	var held []lockCase
	for _, c := range table.Cases {
		if c.Held {
			held = append(held, c)
		}
	}
	if len(held) == 0 {
		t.Fatal("the table holds no held case")
	}
	return held
}

// contract: endpoint.lock.case-table-held
func TestTheHostRefusesAHeldLockOfEachCaseWithItsText(t *testing.T) {
	const deadPID = "2147483646"
	live := fmt.Sprint(os.Getpid())
	substitute := strings.NewReplacer("$LIVE", live, "$DEAD", deadPID)
	for _, c := range heldLockCases(t) {
		t.Run(c.ID, func(t *testing.T) {
			config := t.TempDir()
			lock := filepath.Join(config, "process.lock")
			content := substitute.Replace(c.Content)
			if err := os.WriteFile(lock, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			// The case is a live owner: it holds the advisory lock while the endpoint starts.
			owner, err := os.Open(lock)
			if err != nil {
				t.Fatal(err)
			}
			defer owner.Close()
			if err := syscall.Flock(int(owner.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
				t.Fatal(err)
			}
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			endpoint := host.NewEndpoint(newFakeBackend())
			info := host.EndpointInfo{Transport: "tcp", Address: listener.Addr().String(), PID: os.Getpid(),
				Application: "wailsv3", Version: "0.0.8", Started: time.Now()}
			err = endpoint.Serve(listener, info, config)
			owned := fmt.Sprintf("configuration directory %s is already owned", config)
			var want string
			switch c.Outcome {
			case "refused-live":
				want = fmt.Sprintf("%s by process %s", owned, substitute.Replace(c.Pid))
			case "refused-held-invalid":
				want = fmt.Sprintf("%s by a live process; process.lock is not the current form: %s", owned, content)
			case "refused-held-empty":
				want = fmt.Sprintf("%s by a live process", owned)
			default:
				t.Fatalf("unknown outcome %q", c.Outcome)
			}
			if err == nil || err.Error() != want {
				t.Fatalf("error %v, want %q", err, want)
			}
		})
	}
}
