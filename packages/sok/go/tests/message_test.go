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
	code, stdout, stderr := messageSend(t, home, "app-1", "--reply", folder, text)
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
	code, stdout, stderr := messageSend(t, home, "app-1", "--reply", folder, text)
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
	root := terminalFolders(t, "app-2")
	folder := filepath.Join(root, ".soksak", "messages", "app-2")
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
	// The send adds the request for a report to the folder of the sender (docs/spec/messaging.md#report-request).
	want := text + ` (끝나면 결과를 sok message send --reply ` + filepath.Join(root, ".soksak", "messages", "app-1") + ` "<보고>"로 보고하라)`
	if string(written) != want {
		t.Fatalf("the message is %q, want %q", written, want)
	}
}

func TestSendReplyWritesTheTextAloneAsAReport(t *testing.T) {
	home := t.TempDir()
	root := terminalFolders(t, "app-2")
	folder := filepath.Join(root, ".soksak", "messages", "app-2")
	code, stdout, stderr := messageSend(t, home, "app-1", "--reply", folder, "done 안녕")
	if code != 0 {
		t.Fatalf("stdout: %s stderr: %s", stdout, stderr)
	}
	name := messageName(t, stdout)
	token := strings.TrimSuffix(strings.TrimPrefix(name, "app-1."), ".txt")
	if !strings.HasPrefix(token, "report-") || strings.Contains(token, ".") {
		t.Fatalf("a report has the name <from>.report-<token>.txt; name: %s", name)
	}
	written, err := os.ReadFile(filepath.Join(folder, name))
	if err != nil {
		t.Fatal(err)
	}
	if string(written) != "done 안녕" {
		t.Fatalf("a report holds the text alone; it is %q", written)
	}
}

func TestSendRefusesAFolderOfNoTerminalWithoutReplyWithNoFile(t *testing.T) {
	home := t.TempDir()
	folder := t.TempDir()
	code, stdout, stderr := messageSend(t, home, "app-1", folder, "text")
	if code == 0 {
		t.Fatalf("stdout: %s", stdout)
	}
	if !strings.Contains(stderr, "is not the folder of a terminal") {
		t.Fatalf("the refusal must name the folder rule; stderr: %s", stderr)
	}
	if names := messageEntries(t, folder); len(names) != 0 {
		t.Fatalf("a refused send must write no file; entries: %v", names)
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

// terminalFolders creates <root>/.soksak/messages/<surface> for each surface and returns root.
func terminalFolders(t *testing.T, surfaces ...string) string {
	t.Helper()
	root := t.TempDir()
	for _, surface := range surfaces {
		if err := os.MkdirAll(filepath.Join(root, ".soksak", "messages", surface), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// messageReceiver returns the receiver member of the reply of sok message send as compact JSON.
func messageReceiver(t *testing.T, stdout string) string {
	t.Helper()
	var reply struct {
		Receiver json.RawMessage `json:"receiver"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &reply); err != nil || reply.Receiver == nil {
		t.Fatalf("reply has no receiver: %v: %s", err, stdout)
	}
	var value any
	if err := json.Unmarshal(reply.Receiver, &value); err != nil {
		t.Fatal(err)
	}
	compact, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(compact)
}

// contract: cli.message.send-reports-the-hold-of-the-receiver
func TestSendReportsTheHoldOfTheReceiver(t *testing.T) {
	player := playCase(t, "sok-message-send-receiver")
	home := t.TempDir()
	root := terminalFolders(t, "t2", "t3", "t4", "t5", "gone")
	folder := func(surface string) string { return filepath.Join(root, ".soksak", "messages", surface) }
	wants := []struct{ surface, receiver string }{
		{"t2", `{"held":{"kind":"permission","pending":1,"reason":"blocked"},"plugin":"terminal","surface":"t2"}`},
		{"t3", `{"held":null,"plugin":"terminal","surface":"t3"}`},
		{"t4", `null`},
	}
	for _, want := range wants {
		code, stdout, stderr := messageSend(t, home, "t1", "--config-dir", player.configDir, folder(want.surface), "hello")
		if code != 0 {
			t.Fatalf("send to %s: code %d stdout %q stderr %q", want.surface, code, stdout, stderr)
		}
		if got := messageReceiver(t, stdout); got != want.receiver {
			t.Fatalf("send to %s: receiver %s, want %s", want.surface, got, want.receiver)
		}
		if names := messageEntries(t, folder(want.surface)); len(names) != 1 || names[0] != messageName(t, stdout) {
			t.Fatalf("send to %s: entries %v", want.surface, names)
		}
	}
	code, stdout, stderr := messageSend(t, home, "t1", "--config-dir", player.configDir, folder("t5"), "hello")
	names := messageEntries(t, folder("t5"))
	if code != 1 || stdout != "" || len(names) != 1 || !strings.Contains(stderr, "message "+names[0]+" was written") ||
		!strings.Contains(stderr, "status terminal.messages of surface t5 is not {folder, registration, held, last}") {
		t.Fatalf("a status without held: code %d stdout %q stderr %q entries %v", code, stdout, stderr, names)
	}
	code, stdout, stderr = messageSend(t, home, "t1", "--config-dir", player.configDir, folder("gone"), "hello")
	if code != 0 || messageReceiver(t, stdout) != "null" {
		t.Fatalf("a surface in no window: code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.message.send-without-application-has-no-receiver
func TestSendWithoutAnApplicationOrToAnotherFolderHasNoReceiver(t *testing.T) {
	home := t.TempDir()
	config := t.TempDir()
	root := terminalFolders(t, "t2")
	for _, folder := range []string{filepath.Join(root, ".soksak", "messages", "t2"), t.TempDir()} {
		code, stdout, stderr := messageSend(t, home, "t1", "--config-dir", config, "--reply", folder, "hello")
		if code != 0 || messageReceiver(t, stdout) != "null" {
			t.Fatalf("send to %s: code %d stdout %q stderr %q", folder, code, stdout, stderr)
		}
	}
}
