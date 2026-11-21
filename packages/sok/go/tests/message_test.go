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

// messageSend runs `sok message send` with the configuration directory config and args, with HOME set to home and CODEX_THREAD_ID
// set to thread when it is not empty, and returns the status and both outputs.
func messageSend(t *testing.T, home, config, thread string, args ...string) (int, string, string) {
	t.Helper()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_THREAD_ID", thread)
	if thread == "" {
		if err := os.Unsetenv("CODEX_THREAD_ID"); err != nil {
			t.Fatal(err)
		}
	}
	var stdout, stderr bytes.Buffer
	all := append([]string{"message", "send", "--config-dir", config}, args...)
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

// contract: cli.message.report-text-byte-limit
func TestSendRefusesATextOneByteOverTheLimitWithNoFile(t *testing.T) {
	home := t.TempDir()
	folder := t.TempDir()
	text := strings.Repeat("a", messageLimit+1)
	code, stdout, stderr := messageSend(t, home, playCase(t, "sok-message-send-sender").configDir, "", "--reply", folder, text)
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

// contract: cli.message.report-text-byte-limit
func TestSendAcceptsATextOfExactlyTheLimit(t *testing.T) {
	home := t.TempDir()
	folder := t.TempDir()
	text := strings.Repeat("b", messageLimit)
	code, stdout, stderr := messageSend(t, home, playCase(t, "sok-message-send-sender").configDir, "", "--reply", folder, text)
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

// contract: cli.message.send-writes-complete-request
func TestSendWritesTheWholeTextUnderTheSenderNameAndLeavesNoTemporaryFile(t *testing.T) {
	home := t.TempDir()
	root := terminalFolders(t, "app-2")
	folder := filepath.Join(root, ".soksak", "messages", "app-2")
	text := "hello 안녕 terminal"
	code, stdout, stderr := messageSend(t, home, playCase(t, "sok-message-send-terminal").configDir, "", folder, text)
	if code != 0 {
		t.Fatalf("stdout: %s stderr: %s", stdout, stderr)
	}
	name := messageName(t, stdout)
	if !strings.HasPrefix(name, "app-1.") || !strings.HasSuffix(name, ".txt") {
		t.Fatalf("the name must be <from>.<token>.txt with the sender that agent.surface answers; name: %s", name)
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
	want := text + ` (When done, report the result with sok message send --reply ` + filepath.Join(root, ".soksak", "messages", "app-1") + ` --answers ` + token + ` "<report>")`
	if string(written) != want {
		t.Fatalf("the message is %q, want %q", written, want)
	}
}

// contract: cli.message.report-writes-only-text
func TestSendReplyWritesTheTextAloneAsAReport(t *testing.T) {
	home := t.TempDir()
	root := terminalFolders(t, "app-2")
	folder := filepath.Join(root, ".soksak", "messages", "app-2")
	code, stdout, stderr := messageSend(t, home, playCase(t, "sok-message-send-terminal").configDir, "", "--reply", folder, "done 안녕")
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

// contract: cli.message.send-requires-a-terminal-folder
func TestSendRefusesAFolderOfNoTerminalWithoutReplyWithNoFile(t *testing.T) {
	home := t.TempDir()
	folder := t.TempDir()
	code, stdout, stderr := messageSend(t, home, playCase(t, "sok-message-send-sender").configDir, "", folder, "text")
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

// contract: cli.message.send-requires-the-surface-of-its-process
func TestSendRefusesWithoutASurfaceWithNoFile(t *testing.T) {
	home := t.TempDir()
	folder := t.TempDir()
	code, stdout, stderr := messageSend(t, home, t.TempDir(), "", "--reply", folder, "text")
	if code != 1 || stdout != "" || stderr != "sok: message send requires a running application, which answers the surface of this process\n" {
		t.Fatalf("without an application: code %d stdout %q stderr %q", code, stdout, stderr)
	}
	refusal := "process 1 is not a process of a surface"
	player := playCase(t, "sok-message-send-refused", withText("refusal", refusal))
	hint := "; start codex with --no-daemon, so that the commands of its agent run in processes of the surface"
	for _, thread := range []string{"", "thread-1"} {
		want := "sok: message send: " + refusal + "\n"
		if thread != "" {
			want = "sok: message send: " + refusal + hint + "\n"
		}
		code, stdout, stderr = messageSend(t, home, player.configDir, thread, "--reply", folder, "text")
		if code != 1 || stdout != "" || stderr != want {
			t.Fatalf("a refusal with CODEX_THREAD_ID %q: code %d stdout %q stderr %q, want stderr %q", thread, code, stdout, stderr, want)
		}
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
		code, stdout, stderr := messageSend(t, home, player.configDir, "", folder(want.surface), "hello")
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
	code, stdout, stderr := messageSend(t, home, player.configDir, "", folder("t5"), "hello")
	names := messageEntries(t, folder("t5"))
	if code != 1 || stdout != "" || len(names) != 1 || !strings.Contains(stderr, "message "+names[0]+" was written") ||
		!strings.Contains(stderr, "status terminal.messages of surface t5 is not {folder, registration, held, last}") {
		t.Fatalf("a status without held: code %d stdout %q stderr %q entries %v", code, stdout, stderr, names)
	}
	code, stdout, stderr = messageSend(t, home, player.configDir, "", folder("gone"), "hello")
	if code != 0 || messageReceiver(t, stdout) != "null" {
		t.Fatalf("a surface in no window: code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.message.send-into-another-folder-has-no-receiver
func TestSendToAnotherFolderHasNoReceiver(t *testing.T) {
	home := t.TempDir()
	folder := t.TempDir()
	code, stdout, stderr := messageSend(t, home, playCase(t, "sok-message-send-sender", withText("sender", "t1")).configDir, "", "--reply", folder, "hello")
	if code != 0 || messageReceiver(t, stdout) != "null" || !strings.HasPrefix(messageName(t, stdout), "t1.report-") {
		t.Fatalf("send to %s: code %d stdout %q stderr %q", folder, code, stdout, stderr)
	}
}

// The report that answers a message names the message by its token and writes the receipt into the folder of the reporting surface
// (docs/spec/messaging.md#report-request).
// contract: cli.message.report-writes-the-receipt
func TestSendReplyWithAnswersNamesTheReportAndWritesTheReceipt(t *testing.T) {
	home := t.TempDir()
	root := terminalFolders(t, "app-1", "app-2")
	folder := filepath.Join(root, ".soksak", "messages", "app-2")
	own := filepath.Join(root, ".soksak", "messages", "app-1")
	code, stdout, stderr := messageSend(t, home, playCase(t, "sok-message-send-terminal").configDir, "", "--reply", "--answers", "tok42", folder, "done 안녕")
	if code != 0 {
		t.Fatalf("stdout: %s stderr: %s", stdout, stderr)
	}
	if name := messageName(t, stdout); name != "app-1.report-tok42.txt" {
		t.Fatalf("a report that answers a message is named <from>.report-<token>.txt with the answered token; name: %s", name)
	}
	written, err := os.ReadFile(filepath.Join(folder, "app-1.report-tok42.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(written) != "done 안녕" {
		t.Fatalf("a report holds the text alone; it is %q", written)
	}
	if names := messageEntries(t, own); len(names) != 1 || names[0] != "app-1.receipt-tok42.txt" {
		t.Fatalf("the reporting folder must hold the receipt of the token; entries: %v", names)
	}
	receipt, err := os.ReadFile(filepath.Join(own, "app-1.receipt-tok42.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if len(receipt) != 0 {
		t.Fatalf("a receipt is an empty file; it holds %q", receipt)
	}
}

// A token that holds a dot is refused before any file is written (docs/spec/messaging.md#report-request).
// contract: cli.message.report-refuses-invalid-answers
func TestSendReplyWithAnswersRefusesATokenWithADotWithNoFile(t *testing.T) {
	home := t.TempDir()
	root := terminalFolders(t, "app-1", "app-2")
	folder := filepath.Join(root, ".soksak", "messages", "app-2")
	own := filepath.Join(root, ".soksak", "messages", "app-1")
	code, stdout, stderr := messageSend(t, home, t.TempDir(), "", "--reply", "--answers", "a.b", folder, "done")
	if code == 0 {
		t.Fatalf("stdout: %s", stdout)
	}
	if !strings.Contains(stderr, "is not a token") {
		t.Fatalf("the refusal must name the token rule; stderr: %s", stderr)
	}
	if names := messageEntries(t, folder); len(names) != 0 {
		t.Fatalf("a refused report must write no file; entries: %v", names)
	}
	if names := messageEntries(t, own); len(names) != 0 {
		t.Fatalf("a refused report must write no receipt; entries: %v", names)
	}
}

// A report with an answered token needs the folder of the reporting surface for its receipt, so a missing folder refuses the
// report before it is written (docs/spec/messaging.md#report-request).
// contract: cli.message.report-refuses-invalid-answers
func TestSendReplyWithAnswersRefusesAMissingReceiptFolderWithNoFile(t *testing.T) {
	home := t.TempDir()
	root := terminalFolders(t, "app-2")
	folder := filepath.Join(root, ".soksak", "messages", "app-2")
	code, stdout, stderr := messageSend(t, home, playCase(t, "sok-message-send-sender").configDir, "", "--reply", "--answers", "tok42", folder, "done")
	if code == 0 {
		t.Fatalf("stdout: %s", stdout)
	}
	if !strings.Contains(stderr, "receipt") {
		t.Fatalf("the refusal must name the receipt folder; stderr: %s", stderr)
	}
	if names := messageEntries(t, folder); len(names) != 0 {
		t.Fatalf("a refused report must write no file; entries: %v", names)
	}
}

// --answers belongs to a report, so it without --reply is refused with no file (docs/spec/messaging.md#report-request).
// contract: cli.message.report-refuses-invalid-answers
func TestSendAnswersWithoutReplyIsRefusedWithNoFile(t *testing.T) {
	home := t.TempDir()
	root := terminalFolders(t, "app-1", "app-2")
	folder := filepath.Join(root, ".soksak", "messages", "app-2")
	code, stdout, stderr := messageSend(t, home, t.TempDir(), "", "--answers", "tok42", folder, "text")
	if code == 0 {
		t.Fatalf("stdout: %s", stdout)
	}
	if !strings.Contains(stderr, "requires --reply") {
		t.Fatalf("the refusal must name the --reply rule; stderr: %s", stderr)
	}
	if names := messageEntries(t, folder); len(names) != 0 {
		t.Fatalf("a refused send must write no file; entries: %v", names)
	}
}
