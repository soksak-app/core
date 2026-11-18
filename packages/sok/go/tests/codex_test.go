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
