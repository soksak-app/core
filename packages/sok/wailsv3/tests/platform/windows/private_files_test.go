//go:build windows

package windows

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/windows"
)

// contract: cli.private-files.operations-are-unsupported-on-windows
func TestPrivateFileOperationsFailExplicitlyWithoutCreatingFiles(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	logs := filepath.Join(root, "logs")
	logFile := filepath.Join(logs, "sok-boot.jsonl")
	lockFile := filepath.Join(root, "process.lock")

	if err := current.PrepareLogDirectory(logs); err == nil || err.Error() != fmt.Sprintf("event log directory %s is not implemented on windows", logs) {
		t.Fatalf("prepare log directory error %v", err)
	}
	if _, err := current.CreateLogFile(logFile); err == nil || err.Error() != fmt.Sprintf("event log file %s is not implemented on windows", logFile) {
		t.Fatalf("create log file error %v", err)
	}
	if _, err := current.AppendLogFile(logFile); err == nil || err.Error() != fmt.Sprintf("event log file %s is not implemented on windows", logFile) {
		t.Fatalf("append log file error %v", err)
	}
	if _, err := current.OpenProcessLockFile(lockFile); err == nil || err.Error() != fmt.Sprintf("process lock file %s is not implemented on windows", lockFile) {
		t.Fatalf("open process lock error %v", err)
	}
	for _, path := range []string{logs, logFile, lockFile} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("unsupported operation created %s: %v", path, err)
		}
	}
}
