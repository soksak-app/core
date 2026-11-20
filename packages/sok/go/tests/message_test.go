package tests

// Checks `sok message send <folder> <text>` (docs/spec/cli.md#commands, docs/spec/messaging.md#message) with the built sok and folders
// that each test creates. The tests mirror the Rust tests of packages/sok/rust/tests/message_test.rs: the same names in Go form, the
// same inputs and the same expected results.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// messageLimit is the largest text that the command accepts, in bytes (docs/spec/cli.md#commands).
const messageLimit = 64 * 1024

// messageSend runs `sok message send` with args, with SOKSAK_SURFACE set to surface when it is not empty and HOME set to home, and
// returns the status and both outputs.
func messageSend(t *testing.T, home, surface string, args ...string) (int, string, string) {
	t.Helper()
	t.Setenv("HOME", home)
	if surface == "" {
		t.Setenv("SOKSAK_SURFACE", "")
		if err := os.Unsetenv("SOKSAK_SURFACE"); err != nil {
			t.Fatal(err)
		}
	} else {
		t.Setenv("SOKSAK_SURFACE", surface)
	}
	var stdout, stderr bytes.Buffer
	all := append([]string{"message", "send"}, args...)
	code := sok.Run(all, &stdout, &stderr, sok.Options{Identifier: "app.soksak.wails"})
	return code, stdout.String(), stderr.String()
}

// messageEntries returns the names of the entries of folder, sorted.
func messageEntries(t *testing.T, folder string) []string {
	t.Helper()
	entries, err := os.ReadDir(folder)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

// messageName returns the path member of the reply of sok message send, which is the name of the message file.
func messageName(t *testing.T, stdout string) string {
	t.Helper()
	var reply struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &reply); err != nil {
		t.Fatalf("reply is not JSON: %v: %s", err, stdout)
	}
	return reply.Path
}

func TestSendRefusesATextOneByteOverTheLimitWithNoFile(t *testing.T) {
	home := t.TempDir()
	folder := t.TempDir()
	text := strings.Repeat("a", messageLimit+1)
	code, stdout, stderr := messageSend(t, home, "app-1", folder, text)
	if code == 0 {
		t.Fatalf("an oversized text must fail; stdout: %s", stdout)
	}
	if !strings.Contains(stderr, "65536") {
		t.Fatalf("the refusal must name the limit in bytes; stderr: %s", stderr)
	}
	if names := messageEntries(t, folder); len(names) != 0 {
		t.Fatalf("a refused text must write no file; entries: %v", names)
	}
}

func TestSendAcceptsATextOfExactlyTheLimit(t *testing.T) {
	home := t.TempDir()
	folder := t.TempDir()
	text := strings.Repeat("b", messageLimit)
	code, stdout, stderr := messageSend(t, home, "app-1", folder, text)
	if code != 0 {
		t.Fatalf("stdout: %s stderr: %s", stdout, stderr)
	}
	written, err := os.ReadFile(filepath.Join(folder, messageName(t, stdout)))
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != messageLimit {
		t.Fatalf("the message holds %d bytes, want %d", len(written), messageLimit)
	}
}

func TestSendWritesTheWholeTextUnderTheSenderNameAndLeavesNoTemporaryFile(t *testing.T) {
	home := t.TempDir()
	folder := t.TempDir()
	text := "hello 안녕 terminal"
	code, stdout, stderr := messageSend(t, home, "app-1", folder, text)
	if code != 0 {
		t.Fatalf("stdout: %s stderr: %s", stdout, stderr)
	}
	name := messageName(t, stdout)
	if !strings.HasPrefix(name, "app-1.") || !strings.HasSuffix(name, ".txt") {
		t.Fatalf("the name must be <from>.<token>.txt with the sender of SOKSAK_SURFACE; name: %s", name)
	}
	token := strings.TrimSuffix(strings.TrimPrefix(name, "app-1."), ".txt")
	if token == "" || strings.Contains(token, ".") {
		t.Fatalf("the token must be non-empty and hold no dot; token: %s", token)
	}
	if names := messageEntries(t, folder); len(names) != 1 || names[0] != name {
		t.Fatalf("the folder must hold only the message file after the send; entries: %v, want [%s]", names, name)
	}
	written, err := os.ReadFile(filepath.Join(folder, name))
	if err != nil {
		t.Fatal(err)
	}
	if string(written) != text {
		t.Fatalf("the message is %q, want %q", written, text)
	}
}

func TestSendRefusesWithoutASurfaceWithNoFile(t *testing.T) {
	home := t.TempDir()
	folder := t.TempDir()
	code, stdout, stderr := messageSend(t, home, "", folder, "text")
	if code == 0 {
		t.Fatalf("stdout: %s", stdout)
	}
	if !strings.Contains(stderr, "message send requires SOKSAK_SURFACE") {
		t.Fatalf("the refusal must name the variable of the send; stderr: %s", stderr)
	}
	if names := messageEntries(t, folder); len(names) != 0 {
		t.Fatalf("a refused send must write no file; entries: %v", names)
	}
}
