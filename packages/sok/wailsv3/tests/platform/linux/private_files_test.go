//go:build linux

package linux

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/linux"
)

func selectedPlatform(t *testing.T) platform.Platform {
	t.Helper()
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	return current
}

func permission(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

// contract: cli.private-files.operations-use-owner-only-permissions
func TestPrepareLogDirectoryCreatesAndRestrictsDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	leaf := filepath.Join(root, "nested", "logs")
	if err := selectedPlatform(t).PrepareLogDirectory(leaf); err != nil {
		t.Fatal(err)
	}
	if got := permission(t, leaf); got != 0o700 {
		t.Fatalf("new log directory mode %o, want 700", got)
	}
	if got := permission(t, root); got != 0o755 {
		t.Fatalf("parent directory mode %o, want preserved 755", got)
	}
	if err := os.Chmod(leaf, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := selectedPlatform(t).PrepareLogDirectory(leaf); err != nil {
		t.Fatal(err)
	}
	if got := permission(t, leaf); got != 0o700 {
		t.Fatalf("existing log directory mode %o, want 700", got)
	}
}

// contract: cli.private-files.operations-use-owner-only-permissions
func TestCreateLogFileIsNewAndOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sok.jsonl")
	file, err := selectedPlatform(t).CreateLogFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if got := permission(t, path); got != 0o600 {
		t.Fatalf("new event-log file mode %o, want 600", got)
	}
	if _, err := selectedPlatform(t).CreateLogFile(path); !errors.Is(err, os.ErrExist) {
		t.Fatalf("creating the existing event-log file returned %v, want existence error", err)
	}
}

// contract: cli.private-files.operations-use-owner-only-permissions
func TestAppendLogFileCreatesOwnerOnlyAndPreservesExistingMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sok.stderr")
	for _, text := range []string{"first\n", "second\n"} {
		file, err := selectedPlatform(t).AppendLogFile(path)
		if err != nil {
			t.Fatal(err)
		}
		_, writeErr := io.WriteString(file, text)
		if err := errors.Join(writeErr, file.Close()); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "first\nsecond\n" {
		t.Fatalf("appended file contains %q", data)
	}
	if got := permission(t, path); got != 0o600 {
		t.Fatalf("new appended file mode %o, want 600", got)
	}
	shared := filepath.Join(t.TempDir(), "shared.log")
	if err := os.WriteFile(shared, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	file, err := selectedPlatform(t).AppendLogFile(shared)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if got := permission(t, shared); got != 0o644 {
		t.Fatalf("existing appended file mode %o, want preserved 644", got)
	}
}

// contract: cli.private-files.operations-use-owner-only-permissions
func TestOpenProcessLockFileCreatesOwnerOnlyAndPreservesExistingMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "process.lock")
	file, err := selectedPlatform(t).OpenProcessLockFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if got := permission(t, path); got != 0o600 {
		t.Fatalf("new process-lock file mode %o, want 600", got)
	}
	shared := filepath.Join(t.TempDir(), "existing.lock")
	if err := os.WriteFile(shared, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	file, err = selectedPlatform(t).OpenProcessLockFile(shared)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if got := permission(t, shared); got != 0o644 {
		t.Fatalf("existing process-lock file mode %o, want preserved 644", got)
	}
}
