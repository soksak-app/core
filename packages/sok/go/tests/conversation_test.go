package tests

// Checks `sok conversation read` (docs/spec/agent-conversation.md) with session files that each test writes into its own disposable
// home folder. The tests mirror the Rust tests of packages/sok/rust/tests/conversation_test.rs: the same names in Go form, the same
// records and the same expected results.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// convRun runs `sok conversation read` with args and returns the status and both outputs.
func convRun(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	all := append([]string{"conversation", "read"}, args...)
	code := sok.Run(all, &stdout, &stderr, sok.Options{Identifier: "app.soksak.wails"})
	return code, stdout.String(), stderr.String()
}

// convWriteRecords writes the records as the content of path, one JSON record per line, creating the parent folders.
func convWriteRecords(t *testing.T, path string, records []any) {
	t.Helper()
	var text strings.Builder
	for _, record := range records {
		line, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		text.Write(line)
		text.WriteByte('\n')
	}
	mkdirs(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(text.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

// convClaudeRecords are the Claude Code records of a session whose working directory is cwd: one non-message record, one user
// message, one assistant message with a tool call and a text block, and one user record that holds only a tool result.
func convClaudeRecords(cwd, userText, assistantText string) []any {
	return []any{
		map[string]any{"type": "attachment", "cwd": cwd, "sessionId": "session"},
		map[string]any{"type": "user", "cwd": cwd, "message": map[string]any{"role": "user", "content": userText}},
		map[string]any{"type": "assistant", "cwd": cwd, "message": map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "text", "text": assistantText},
			map[string]any{"type": "tool_use", "id": "call", "name": "read", "input": map[string]any{}},
		}}},
		map[string]any{"type": "user", "cwd": cwd, "message": map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": "call", "content": "ok"},
		}}},
	}
}

// convCodexRecords are the Codex records of a session whose working directory is cwd: a session_meta record, a developer message,
// a user message, a reasoning record and an assistant message.
func convCodexRecords(cwd, userText, assistantText string) []any {
	return []any{
		map[string]any{"type": "session_meta", "payload": map[string]any{"id": "session", "cwd": cwd}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "developer", "content": []any{
			map[string]any{"type": "input_text", "text": "policy"},
		}}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{
			map[string]any{"type": "input_text", "text": userText},
		}}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "reasoning", "summary": []any{}}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "assistant", "content": []any{
			map[string]any{"type": "output_text", "text": assistantText},
		}}},
	}
}

// convExpected is the output that the command writes for a chosen file, with its messages and skipped count.
func convExpected(file string, messages []any, skipped float64) map[string]any {
	return map[string]any{"file": file, "messages": messages, "skipped": skipped}
}

// convDecode decodes the standard output of the command as a JSON object.
func convDecode(t *testing.T, stdout string) map[string]any {
	t.Helper()
	var output map[string]any
	if err := json.Unmarshal([]byte(stdout), &output); err != nil {
		t.Fatalf("JSON output %q: %v", stdout, err)
	}
	return output
}

// contract: conversation.claude-code.selects-the-file-by-cwd
func TestClaudeCodeFileIsSelectedByCwd(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/project.one/core"
	file := filepath.Join(h.home, ".claude/projects/-work-project-one-core/session.jsonl")
	convWriteRecords(t, file, convClaudeRecords(cwd, "question", "answer"))
	convWriteRecords(t, filepath.Join(h.home, ".claude/projects/-work-other/session.jsonl"), convClaudeRecords("/work/other", "other", "other"))

	code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", cwd)

	if code != 0 || stderr != "" {
		t.Fatalf("exit status %d and standard error %q", code, stderr)
	}
	want := convExpected(file, []any{
		map[string]any{"role": "user", "text": "question"},
		map[string]any{"role": "assistant", "text": "answer"},
	}, 2)
	if got := convDecode(t, stdout); !reflect.DeepEqual(got, want) {
		t.Fatalf("output %v, want %v", got, want)
	}
}

// contract: conversation.codex.selects-the-file-by-payload-cwd
func TestCodexFileIsSelectedByPayloadCwd(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/project.one/core"
	file := filepath.Join(h.home, ".codex/sessions/2026/11/18/rollout-2026-11-18T10-00-00-session.jsonl")
	convWriteRecords(t, file, convCodexRecords(cwd, "question", "answer"))
	convWriteRecords(t, filepath.Join(h.home, ".codex/sessions/2026/11/17/rollout-2026-11-17T10-00-00-other.jsonl"), convCodexRecords("/work/other", "other", "other"))

	code, stdout, stderr := convRun(t, "--agent", "codex", "--cwd", cwd)

	if code != 0 || stderr != "" {
		t.Fatalf("exit status %d and standard error %q", code, stderr)
	}
	want := convExpected(file, []any{
		map[string]any{"role": "user", "text": "question"},
		map[string]any{"role": "assistant", "text": "answer"},
	}, 3)
	if got := convDecode(t, stdout); !reflect.DeepEqual(got, want) {
		t.Fatalf("output %v, want %v", got, want)
	}
}

// contract: conversation.selects-the-most-recently-modified-file
func TestTwoMatchingFilesChooseTheMostRecentlyModified(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/project.one/core"
	folder := filepath.Join(h.home, ".claude/projects/-work-project-one-core")
	older := filepath.Join(folder, "a-older.jsonl")
	newer := filepath.Join(folder, "z-newer.jsonl")
	convWriteRecords(t, older, convClaudeRecords(cwd, "older", "older"))
	convWriteRecords(t, newer, convClaudeRecords(cwd, "newer", "newer"))
	base := time.Now()
	if err := os.Chtimes(older, base, base.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(newer, base, base); err != nil {
		t.Fatal(err)
	}

	code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", cwd)

	if code != 0 || stderr != "" {
		t.Fatalf("exit status %d and standard error %q", code, stderr)
	}
	output := convDecode(t, stdout)
	if output["file"] != newer {
		t.Fatalf("the chosen file %v, want %s", output["file"], newer)
	}
	want := []any{
		map[string]any{"role": "user", "text": "newer"},
		map[string]any{"role": "assistant", "text": "newer"},
	}
	if !reflect.DeepEqual(output["messages"], want) {
		t.Fatalf("messages %v, want %v", output["messages"], want)
	}
}

// contract: conversation.refuses-when-no-file-matches
func TestNoMatchingFileIsRefusedWithTheCwd(t *testing.T) {
	h := newAgentHome(t)
	convWriteRecords(t, filepath.Join(h.home, ".claude/projects/-work-other/session.jsonl"), convClaudeRecords("/work/other", "other", "other"))

	code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", "/work/none")

	if code != 1 || stdout != "" || stderr != "sok: no claude-code session file has the working directory /work/none\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.refuses-a-relative-cwd
func TestRelativeCwdIsRefused(t *testing.T) {
	newAgentHome(t)

	code, stdout, stderr := convRun(t, "--agent", "codex", "--cwd", "relative/core")

	if code != 1 || stdout != "" || stderr != "sok: cwd is not an absolute path: relative/core\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.refuses-an-unknown-agent
func TestUnknownAgentIsRefused(t *testing.T) {
	newAgentHome(t)

	code, stdout, stderr := convRun(t, "--agent", "cursor", "--cwd", "/work/project")

	if code != 1 || stdout != "" || stderr != "sok: unknown agent cursor\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.refuses-an-unreadable-file-with-its-reason
func TestUnreadableFileIsRefusedWithItsReason(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/project.one/core"
	file := filepath.Join(h.home, ".claude/projects/-work-project-one-core/session.jsonl")
	convWriteRecords(t, file, convClaudeRecords(cwd, "question", "answer"))
	if err := os.Chmod(file, 0o000); err != nil {
		t.Fatal(err)
	}

	code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", cwd)

	// Restores the mode so that the folder can be removed when the test ends.
	if err := os.Chmod(file, 0o600); err != nil {
		t.Fatal(err)
	}
	if code != 1 || stdout != "" || stderr != "sok: "+file+": permission denied\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.refuses-a-session-working-directory-that-is-not-a-string
func TestClaudeCwdThatIsNotAStringIsRefused(t *testing.T) {
	h := newAgentHome(t)
	file := filepath.Join(h.home, ".claude/projects/-work-core/session.jsonl")
	convWriteRecords(t, file, []any{
		map[string]any{"type": "user", "cwd": 5, "message": map[string]any{"role": "user", "content": "question"}},
	})

	code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", "/work/core")

	if code != 1 || stdout != "" || stderr != "sok: "+file+": the session working directory is missing or not a string\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.refuses-a-session-working-directory-that-is-not-a-string
func TestCodexFileThatDoesNotStartWithSessionMetaIsRefused(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/core"
	file := filepath.Join(h.home, ".codex/sessions/2026/11/18/rollout-2026-11-18T10-00-00-first.jsonl")
	convWriteRecords(t, file, []any{
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{
			map[string]any{"type": "input_text", "text": "first"},
		}}},
		map[string]any{"type": "session_meta", "payload": map[string]any{"id": "session", "cwd": cwd}},
	})

	code, stdout, stderr := convRun(t, "--agent", "codex", "--cwd", cwd)

	if code != 1 || stdout != "" || stderr != "sok: "+file+": the session working directory is missing or not a string\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.reads-an-unchosen-file-only-to-its-session-record
func TestMalformedLineAfterTheSessionRecordOfAnUnchosenFileIsNotRead(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/project.one/core"
	folder := filepath.Join(h.home, ".claude/projects/-work-project-one-core")
	unchosen := filepath.Join(folder, "a-older.jsonl")
	chosen := filepath.Join(folder, "z-newer.jsonl")
	older, err := json.Marshal(convClaudeRecords(cwd, "older", "older")[1])
	if err != nil {
		t.Fatal(err)
	}
	mkdirs(t, folder)
	if err := os.WriteFile(unchosen, []byte(string(older)+"\nnot a record\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	convWriteRecords(t, chosen, convClaudeRecords(cwd, "newer", "newer"))
	base := time.Now()
	if err := os.Chtimes(unchosen, base, base.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(chosen, base, base); err != nil {
		t.Fatal(err)
	}

	code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", cwd)

	if code != 0 || stderr != "" {
		t.Fatalf("exit status %d and standard error %q", code, stderr)
	}
	if output := convDecode(t, stdout); output["file"] != chosen {
		t.Fatalf("the chosen file %v, want %s", output["file"], chosen)
	}
}

// contract: conversation.does-not-follow-symbolic-links
func TestSymbolicLinkToASessionFileIsNotACandidate(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/core"
	target := filepath.Join(h.home, "elsewhere/rollout-2026-11-18T10-00-00-linked.jsonl")
	convWriteRecords(t, target, convCodexRecords(cwd, "question", "answer"))
	folder := filepath.Join(h.home, ".codex/sessions/2026/11/18")
	mkdirs(t, folder)
	if err := os.Symlink(target, filepath.Join(folder, "rollout-2026-11-18T10-00-00-link.jsonl")); err != nil {
		t.Fatal(err)
	}

	code, stdout, stderr := convRun(t, "--agent", "codex", "--cwd", cwd)

	if code != 1 || stdout != "" || stderr != "sok: no codex session file has the working directory /work/core\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.refuses-a-text-that-is-not-a-string
func TestClaudeTextThatIsNotAStringIsRefused(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/core"
	file := filepath.Join(h.home, ".claude/projects/-work-core/session.jsonl")
	convWriteRecords(t, file, []any{
		map[string]any{"type": "user", "cwd": cwd, "message": map[string]any{"role": "user", "content": "question"}},
		map[string]any{"type": "assistant", "cwd": cwd, "message": map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "text", "text": 5},
		}}},
	})

	code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", cwd)

	if code != 1 || stdout != "" || stderr != "sok: "+file+": line 2 has a text that is not a string\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.refuses-a-content-item-that-is-not-an-object
func TestClaudeContentItemThatIsNotAnObjectIsRefused(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/core"
	file := filepath.Join(h.home, ".claude/projects/-work-core/session.jsonl")
	convWriteRecords(t, file, []any{
		map[string]any{"type": "user", "cwd": cwd, "message": map[string]any{"role": "user", "content": "question"}},
		map[string]any{"type": "assistant", "cwd": cwd, "message": map[string]any{"role": "assistant", "content": []any{
			"plain string item",
		}}},
	})

	code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", cwd)

	if code != 1 || stdout != "" || stderr != "sok: "+file+": line 2 has a content item that is not an object with a string type\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.refuses-a-content-item-that-is-not-an-object
func TestCodexContentItemWithoutAStringTypeIsRefused(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/core"
	file := filepath.Join(h.home, ".codex/sessions/2026/11/18/rollout-2026-11-18T10-00-00-item.jsonl")
	convWriteRecords(t, file, []any{
		map[string]any{"type": "session_meta", "payload": map[string]any{"id": "session", "cwd": cwd}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{
			map[string]any{"text": "question"},
		}}},
	})

	code, stdout, stderr := convRun(t, "--agent", "codex", "--cwd", cwd)

	if code != 1 || stdout != "" || stderr != "sok: "+file+": line 2 has a content item that is not an object with a string type\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.refuses-a-message-content-of-the-wrong-type
func TestClaudeMessageContentThatIsNeitherStringNorListIsRefused(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/core"
	file := filepath.Join(h.home, ".claude/projects/-work-core/session.jsonl")
	convWriteRecords(t, file, []any{
		map[string]any{"type": "user", "cwd": cwd, "message": map[string]any{"role": "user", "content": nil}},
	})

	code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", cwd)

	if code != 1 || stdout != "" || stderr != "sok: "+file+": line 1 has a message content that is neither a string nor a list\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.refuses-a-message-content-of-the-wrong-type
func TestCodexMessageContentThatIsNotAListIsRefused(t *testing.T) {
	h := newAgentHome(t)
	cwd := "/work/core"
	file := filepath.Join(h.home, ".codex/sessions/2026/11/18/rollout-2026-11-18T10-00-00-content.jsonl")
	convWriteRecords(t, file, []any{
		map[string]any{"type": "session_meta", "payload": map[string]any{"id": "session", "cwd": cwd}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": "question"}},
	})

	code, stdout, stderr := convRun(t, "--agent", "codex", "--cwd", cwd)

	if code != 1 || stdout != "" || stderr != "sok: "+file+": line 2 has a message content that is not a list\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: conversation.claude-code.names-the-folder-by-the-recorded-pairs
func TestFolderNamesFollowTheRecordedPairs(t *testing.T) {
	text, err := os.ReadFile(repositoryFile(t, "docs/spec/cases/conversation-folder-names.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Case   string `json:"case"`
		Folder string `json:"folder"`
		Cwd    string `json:"cwd"`
	}
	if err := json.Unmarshal(text, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("the folder name cases are empty")
	}
	for _, c := range cases {
		t.Run(c.Case, func(t *testing.T) {
			h := newAgentHome(t)
			file := filepath.Join(h.home, ".claude/projects", c.Folder, "session.jsonl")
			convWriteRecords(t, file, convClaudeRecords(c.Cwd, "question", "answer"))

			code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", c.Cwd)

			if code != 0 || stderr != "" {
				t.Fatalf("exit status %d and standard error %q", code, stderr)
			}
			if output := convDecode(t, stdout); output["file"] != file {
				t.Fatalf("the chosen file %v, want %s", output["file"], file)
			}
		})
	}
}

// contract: conversation.codex.keeps-an-image-only-message
func TestCodexImageOnlyMessageIsEmittedWithItsKind(t *testing.T) {
	// The item has the observed key structure of docs/spec/cases/conversation-codex-image-item.json; the image reference is set here.
	var item map[string]any
	if text, err := os.ReadFile(repositoryFile(t, "docs/spec/cases/conversation-codex-image-item.json")); err != nil {
		t.Fatal(err)
	} else if err := json.Unmarshal(text, &item); err != nil {
		t.Fatal(err)
	}
	item["type"] = "input_image"
	item["image_url"] = "PICTURE-DATA-NOT-WRITTEN"

	h := newAgentHome(t)
	cwd := "/work/core"
	file := filepath.Join(h.home, ".codex/sessions/2026/11/18/rollout-2026-11-18T10-00-00-image.jsonl")
	convWriteRecords(t, file, []any{
		map[string]any{"type": "session_meta", "payload": map[string]any{"id": "session", "cwd": cwd}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{item}}},
	})

	code, stdout, stderr := convRun(t, "--agent", "codex", "--cwd", cwd)

	if code != 0 || stderr != "" {
		t.Fatalf("exit status %d and standard error %q", code, stderr)
	}
	if strings.Contains(stdout, "PICTURE-DATA") {
		t.Fatalf("the picture data is written: %s", stdout)
	}
	want := convExpected(file, []any{
		map[string]any{"role": "user", "text": "", "items": []any{map[string]any{"type": "image"}}},
	}, 1)
	if got := convDecode(t, stdout); !reflect.DeepEqual(got, want) {
		t.Fatalf("output %v, want %v", got, want)
	}
}

// contract: conversation.claude-code.keeps-an-image-only-message
func TestClaudeImageOnlyMessageIsEmittedWithItsKind(t *testing.T) {
	// The block has the observed key structure of docs/spec/cases/conversation-image-block.json; the data value is set here.
	var block map[string]any
	if text, err := os.ReadFile(repositoryFile(t, "docs/spec/cases/conversation-image-block.json")); err != nil {
		t.Fatal(err)
	} else if err := json.Unmarshal(text, &block); err != nil {
		t.Fatal(err)
	}
	block["source"].(map[string]any)["data"] = "PICTURE-DATA-NOT-WRITTEN"

	h := newAgentHome(t)
	cwd := "/work/core"
	file := filepath.Join(h.home, ".claude/projects/-work-core/session.jsonl")
	convWriteRecords(t, file, []any{
		map[string]any{"type": "attachment", "cwd": cwd, "sessionId": "session"},
		map[string]any{"type": "user", "cwd": cwd, "message": map[string]any{"role": "user", "content": []any{block}}},
	})

	code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", cwd)

	if code != 0 || stderr != "" {
		t.Fatalf("exit status %d and standard error %q", code, stderr)
	}
	if strings.Contains(stdout, "PICTURE-DATA") {
		t.Fatalf("the picture data is written: %s", stdout)
	}
	want := convExpected(file, []any{
		map[string]any{"role": "user", "text": "", "items": []any{map[string]any{"type": "image"}}},
	}, 1)
	if got := convDecode(t, stdout); !reflect.DeepEqual(got, want) {
		t.Fatalf("output %v, want %v", got, want)
	}
}

// contract: conversation.refuses-a-home-that-is-not-utf-8
func TestHomeThatIsNotUTF8IsRefusedWithItsBytesEscaped(t *testing.T) {
	newAgentHome(t)
	t.Setenv("HOME", "/nonexistent/h\xffme")

	code, stdout, stderr := convRun(t, "--agent", "claude-code", "--cwd", "/work/project")

	if code != 1 || stdout != "" || stderr != "sok: HOME is not UTF-8: /nonexistent/h\\xffme\n" {
		t.Fatalf("status %d stdout %q stderr %q", code, stdout, stderr)
	}
}
