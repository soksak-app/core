// 현재 사용자 전용 파일과 디렉터리의 platform 연산 테스트(docs/spec/hosts.md#platform-interface).
package host_test

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	platform "github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

func currentPlatform(t *testing.T) platform.Platform {
	t.Helper()
	current, err := platform.Current()
	if err != nil {
		t.Fatalf("platform failed: %v", err)
	}
	return current
}

func perm(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

// contract: platform.private.creates-owner-only-directories
func TestCreatePrivateDirectoriesMakesMissingDirectoriesOwnerOnly(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	middle := filepath.Join(root, "middle")
	leaf := filepath.Join(middle, "leaf")
	if err := currentPlatform(t).CreatePrivateDirectories(leaf); err != nil {
		t.Fatalf("create private directories: %v", err)
	}
	for _, path := range []string{middle, leaf} {
		if mode := perm(t, path); mode != 0o700 {
			t.Fatalf("%s has mode %o, want 700", path, mode)
		}
	}
	// 이미 있는 디렉터리의 권한은 바꾸지 않는다.
	if err := currentPlatform(t).CreatePrivateDirectories(root); err != nil {
		t.Fatalf("create an existing directory: %v", err)
	}
	if mode := perm(t, root); mode != 0o755 {
		t.Fatalf("existing directory has mode %o, want 755", mode)
	}
}

// contract: platform.private.appends-owner-only-file
func TestAppendPrivateFileCreatesAnOwnerOnlyFileAndAppends(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private.log")
	for _, line := range []string{"first\n", "second\n"} {
		file, err := currentPlatform(t).AppendPrivateFile(path)
		if err != nil {
			t.Fatalf("append private file: %v", err)
		}
		_, writeErr := io.WriteString(file, line)
		if err := errors.Join(writeErr, file.Close()); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "first\nsecond\n" {
		t.Fatalf("file holds %q", data)
	}
	if mode := perm(t, path); mode != 0o600 {
		t.Fatalf("new file has mode %o, want 600", mode)
	}
	// 이미 있는 파일의 권한은 바꾸지 않는다.
	shared := filepath.Join(t.TempDir(), "shared.log")
	if err := os.WriteFile(shared, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	file, err := currentPlatform(t).AppendPrivateFile(shared)
	if err != nil {
		t.Fatalf("append an existing file: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if mode := perm(t, shared); mode != 0o644 {
		t.Fatalf("existing file has mode %o, want 644", mode)
	}
}

// contract: platform.private.creates-new-owner-only-file
func TestCreatePrivateFileCreatesANewOwnerOnlyFileOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private.lock")
	file, err := currentPlatform(t).CreatePrivateFile(path)
	if err != nil {
		t.Fatalf("create private file: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if mode := perm(t, path); mode != 0o600 {
		t.Fatalf("new file has mode %o, want 600", mode)
	}
	if _, err := currentPlatform(t).CreatePrivateFile(path); !errors.Is(err, os.ErrExist) {
		t.Fatalf("creating an existing file returned %v, want an existence error", err)
	}
}
