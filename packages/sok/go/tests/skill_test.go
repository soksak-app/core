package tests

// Checks the agent skill commands (docs/spec/cli.md#agent-skill): sok skill print writes the skill text, and sok skill install
// writes it into the skill folder of each agent folder that exists.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// skillSource is the skill text of packages/sok/go/src/agents/SKILL.md.
func skillSource(t *testing.T) string {
	t.Helper()
	return fileText(t, repositoryFile(t, "packages/sok/go/src/agents/SKILL.md"))
}

type skillFile struct {
	File  string `json:"file"`
	State string `json:"state"`
}

// installSkills runs sok skill install and decodes its output.
func installSkills(t *testing.T) []skillFile {
	t.Helper()
	code, stdout, stderr := run("skill", "install")
	if code != 0 {
		t.Fatalf("skill install: code %d stderr %q", code, stderr)
	}
	var out struct {
		Skills []skillFile `json:"skills"`
	}
	if err := json.Unmarshal([]byte(stdout), &out); err != nil {
		t.Fatalf("skill install printed %q: %v", stdout, err)
	}
	return out.Skills
}

// folderNames are the names in the folder.
func folderNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// contract: cli.skill.prints-the-text
func TestSkillPrintWritesTheSkillText(t *testing.T) {
	code, stdout, stderr := run("skill", "print")
	if code != 0 || stderr != "" || stdout != skillSource(t) {
		t.Fatalf("code %d stderr %q stdout %q", code, stderr, stdout)
	}
}

// contract: cli.skill.writes-only-existing-agent-folders
func TestSkillInstallWritesOnlyExistingAgentFolders(t *testing.T) {
	h := newAgentHome(t)
	// <home>/.claude is a folder, <home>/.agents a symbolic link to a folder, and CLAUDE_CONFIG_DIR names <home>/.claude through a
	// symbolic link, so its skill folder resolves to the one of <home>/.claude.
	mkdirs(t, filepath.Join(h.home, ".claude"), filepath.Join(h.home, "agents-real"))
	if err := os.Symlink(filepath.Join(h.home, "agents-real"), filepath.Join(h.home, ".agents")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(h.home, ".claude"), filepath.Join(h.home, "claude-link")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(h.home, "claude-link"))
	skills := installSkills(t)
	want := []skillFile{
		{filepath.Join(h.home, ".claude", "skills", "soksak", "SKILL.md"), "written"},
		{filepath.Join(h.home, ".agents", "skills", "soksak", "SKILL.md"), "written"},
	}
	if fmt.Sprint(skills) != fmt.Sprint(want) {
		t.Fatalf("skills %v, want %v", skills, want)
	}
	for _, file := range []string{want[0].File, filepath.Join(h.home, "agents-real", "skills", "soksak", "SKILL.md")} {
		info, err := os.Stat(file)
		if err != nil || info.Mode().Perm() != 0o644 || fileText(t, file) != skillSource(t) {
			t.Fatalf("%s: %v %v", file, info, err)
		}
	}
	// A CLAUDE_CONFIG_DIR that is no folder and a missing <home>/.agents get no skill file.
	h = newAgentHome(t)
	mkdirs(t, filepath.Join(h.home, ".claude"))
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(h.home, "missing"))
	skills = installSkills(t)
	if len(skills) != 1 || skills[0].File != filepath.Join(h.home, ".claude", "skills", "soksak", "SKILL.md") {
		t.Fatalf("skills %v", skills)
	}
	if names := folderNames(t, h.home); fmt.Sprint(names) != "[.claude]" {
		t.Fatalf("home holds %v", names)
	}
}

// contract: cli.skill.rewrites-only-a-differing-file
func TestSkillInstallRewritesOnlyADifferingFile(t *testing.T) {
	sok := builtSok(t)
	h := newAgentHome(t)
	mkdirs(t, filepath.Join(h.home, ".claude"))
	file := filepath.Join(h.home, ".claude", "skills", "soksak", "SKILL.md")
	installSkills(t)
	past := time.Unix(1_000_000_000, 0)
	if err := os.Chtimes(file, past, past); err != nil {
		t.Fatal(err)
	}
	if skills := installSkills(t); len(skills) != 1 || skills[0].State != "current" {
		t.Fatalf("skills %v", skills)
	}
	if info, err := os.Stat(file); err != nil || !info.ModTime().Equal(past) {
		t.Fatalf("a current skill file was written: %v %v", info, err)
	}
	writeText(t, file, "edited by a person\n")
	if skills := installSkills(t); len(skills) != 1 || skills[0].State != "written" || fileText(t, file) != skillSource(t) {
		t.Fatalf("skills %v text %q", skills, fileText(t, file))
	}
	if names := folderNames(t, filepath.Dir(file)); fmt.Sprint(names) != "[SKILL.md]" {
		t.Fatalf("the skill folder holds %v", names)
	}
	// Two installs at once each write through their own temporary file.
	writeText(t, file, "edited again\n")
	var wait sync.WaitGroup
	results := make([]string, 2)
	for n := range results {
		wait.Add(1)
		go func() {
			defer wait.Done()
			code, _, stderr := runProgram(t, sok, environment(), "skill", "install")
			results[n] = fmt.Sprintf("%d %s", code, stderr)
		}()
	}
	wait.Wait()
	if results[0] != "0 " || results[1] != "0 " || fileText(t, file) != skillSource(t) {
		t.Fatalf("results %q text %q", results, fileText(t, file))
	}
	if names := folderNames(t, filepath.Dir(file)); fmt.Sprint(names) != "[SKILL.md]" {
		t.Fatalf("the skill folder holds %v", names)
	}
}

// contract: cli.skill.fails-without-an-agent-folder
func TestSkillInstallFailsWithoutAnAgentFolder(t *testing.T) {
	h := newAgentHome(t)
	code, stdout, stderr := run("skill", "install")
	want := fmt.Sprintf("sok: no agent folder: neither %s/.claude nor %s/.agents is a directory; sok skill print writes the skill to standard output\n", h.home, h.home)
	if code != 1 || stdout != "" || stderr != want {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(h.home, "config"))
	code, _, stderr = run("skill", "install")
	want = fmt.Sprintf("sok: no agent folder: neither %s/.claude nor %s/config nor %s/.agents is a directory; sok skill print writes the skill to standard output\n", h.home, h.home, h.home)
	if code != 1 || stderr != want {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if names := folderNames(t, h.home); len(names) != 0 {
		t.Fatalf("home holds %v", names)
	}
	t.Setenv("HOME", "")
	if code, _, stderr := run("skill", "install"); code != 1 || stderr != "sok: HOME is not set\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	os.Unsetenv("HOME")
	if code, _, stderr := run("skill", "install"); code != 1 || stderr != "sok: HOME is not set\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

// contract: cli.skill.reports-a-failed-write
func TestSkillInstallReportsAFailedWrite(t *testing.T) {
	h := newAgentHome(t)
	// The first agent folder has a skill folder that cannot be written, the second one a skills folder in which the skill folder
	// cannot be created, and the third one is written after both failures.
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(h.home, "config"))
	locked := filepath.Join(h.home, ".claude", "skills", "soksak")
	lockedSkills := filepath.Join(h.home, "config", "skills")
	written := filepath.Join(h.home, ".agents", "skills", "soksak", "SKILL.md")
	mkdirs(t, locked, lockedSkills, filepath.Join(h.home, ".agents"))
	for _, dir := range []string{locked, lockedSkills} {
		if err := os.Chmod(dir, 0o555); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(dir, 0o755) })
	}
	code, stdout, stderr := run("skill", "install")
	var out struct {
		Skills []skillFile `json:"skills"`
	}
	wantStderr := "sok: " + filepath.Join(locked, "SKILL.md") + ": permission denied; " + filepath.Join(lockedSkills, "soksak", "SKILL.md") + ": permission denied\n"
	if err := json.Unmarshal([]byte(stdout), &out); code != 1 || err != nil || fmt.Sprint(out.Skills) != fmt.Sprint([]skillFile{{written, "written"}}) || stderr != wantStderr {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	if fileText(t, written) != skillSource(t) {
		t.Fatalf("the file written after the failures is %q", fileText(t, written))
	}
	if names := folderNames(t, locked); len(names) != 0 {
		t.Fatalf("the locked folder holds %v", names)
	}
	if names := folderNames(t, lockedSkills); len(names) != 0 {
		t.Fatalf("the locked skills folder holds %v", names)
	}
	if names := folderNames(t, filepath.Dir(written)); fmt.Sprint(names) != "[SKILL.md]" {
		t.Fatalf("the skill folder holds %v", names)
	}
}

// TestTheSkillAndTheInstructionsNameTheArrangementCommands checks that the skill and the instructions of the MCP server name the plan
// and the apply of an arrangement and the move of a tab beside the other layout operations, and state that the layout is read again and
// compared with the request after a change (docs/spec/cli.md#agent-skill).
// contract: cli.skill.arrangement-guidance
func TestTheSkillAndTheInstructionsNameTheArrangementCommands(t *testing.T) {
	skill := skillSource(t)
	var server struct {
		Instructions string `json:"instructions"`
	}
	if err := json.Unmarshal([]byte(fileText(t, repositoryFile(t, "packages/sok/go/src/agents/mcp.json"))), &server); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"core.layout.plan", "core.layout.apply", "core.layout.move", "core.layout.open", "core.layout.select", "core.layout.close"} {
		if !strings.Contains(skill, "`"+command+" ") {
			t.Errorf("the skill does not name %s", command)
		}
		if !strings.Contains(server.Instructions, command) {
			t.Errorf("the instructions of the MCP server do not name %s", command)
		}
	}
	if !strings.Contains(skill, "read `layout` again and compare the `frame` of each card with the request") {
		t.Error("the skill does not state the comparison of the frames with the request")
	}
	if !strings.Contains(server.Instructions, "read the frames of the layout again and compare them with the request") {
		t.Error("the instructions of the MCP server do not state the comparison of the frames with the request")
	}
}
