package tests

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The skill of the Codex agent is written to <home>/.agents/skills/soksak/SKILL.md when <home>/.codex is a directory, so that
// Codex reads it; the install creates the agents folder when it does not exist.
// contract: cli.skill.installs-the-codex-folder
func TestSkillInstallCreatesTheCodexAgentFolderWhenCodexIsPresent(t *testing.T) {
	h := newAgentHome(t)
	mkdirs(t, filepath.Join(h.home, ".codex"))
	skills := installSkills(t)
	want := []skillFile{{filepath.Join(h.home, ".agents", "skills", "soksak", "SKILL.md"), "written"}}
	if fmt.Sprint(skills) != fmt.Sprint(want) {
		t.Fatalf("skills %v, want %v", skills, want)
	}
}

// The MCP install registers the running sok with the codex command when codex is on PATH, and reports the state of that
// registration as codex; a second install finds the registration current and runs no codex command.
// contract: cli.mcp.registers-with-codex
func TestMcpInstallRegistersTheSokWithCodexWhenCodexIsOnPath(t *testing.T) {
	f := newRegistrationFixture(t)
	codexDir := setupFixture(t, "codex")
	t.Setenv("PATH", filepath.Dir(f.sok)+string(os.PathListSeparator)+f.claudeDir+string(os.PathListSeparator)+codexDir)
	code, stdout, stderr := f.run(t, "mcp", "install")
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if !strings.Contains(stdout, "\"codex\": \"registered\"") {
		t.Fatalf("output %s, want the codex state registered", stdout)
	}
	want := "codex mcp add soksak -- " + f.running + " mcp"
	if commands := f.commands(t); !containsCommand(commands, want) {
		t.Fatalf("commands %q, want %q", commands, want)
	}
	before := len(f.commands(t))
	code, stdout, stderr = f.run(t, "mcp", "install")
	if code != 0 || !strings.Contains(stdout, "\"codex\": \"current\"") {
		t.Fatalf("second install code %d stdout %s stderr %q", code, stdout, stderr)
	}
	if after := len(f.commands(t)); after != before+1 {
		t.Fatalf("the second install ran %d commands, want the claude command only", after-before)
	}
}

// containsCommand reports whether one of the recorded commands equals want.
func containsCommand(commands []string, want string) bool {
	for _, command := range commands {
		if command == want {
			return true
		}
	}
	return false
}

// The registration with codex creates <home>/.codex, which makes <home>/.agents the Codex agent folder, so the install registers
// before it writes the skills and writes the skill file of that folder too: the install that creates the folder leaves its skill
// current.
// contract: cli.setup.install-writes-the-skill-of-the-folder-that-the-registration-creates
func TestSetupInstallWritesTheSkillOfTheCodexFolderThatTheRegistrationCreates(t *testing.T) {
	f, entry, _ := partsFixture(t)
	writeText(t, entry, filepath.Dir(f.running)+"\n")
	codexDir := setupFixture(t, "codex")
	t.Setenv("PATH", filepath.Dir(f.sok)+string(os.PathListSeparator)+f.claudeDir+string(os.PathListSeparator)+codexDir)
	code, stdout, stderr := f.run(t, "setup", "install")
	want := "path ok changed=false\nskill ok changed=true\nskill ok changed=true\nmcp ok changed=true"
	if code != 0 || describeParts(decodeParts(t, stdout)) != want {
		t.Fatalf("code %d stdout %s stderr %q, want the parts\n%s", code, stdout, stderr, want)
	}
	codexSkill := filepath.Join(f.home, ".agents", "skills", "soksak", "SKILL.md")
	if parts := decodeParts(t, stdout); parts[2].File != codexSkill {
		t.Fatalf("parts %s, want the skill %s", stdout, codexSkill)
	}
}
