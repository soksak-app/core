package tests

// Checks the session restart hook: the install and removal of its entries in the hook file of each user agent folder, and the
// guard of its command (docs/spec/agent-roles.md#session-restart-hook).

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// hookMark is the argument that marks an entry which soksak registered.
const hookMark = " role identity --soksak-hook"

// hookFixture is the registration fixture with the agent folder variables cleared, so that the hook files are the ones of the fixture
// home and not of the configuration of the person who runs the tests.
func hookFixture(t *testing.T) registrationFixture {
	t.Helper()
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "")
	return newRegistrationFixture(t)
}

// settingsFile is the Claude Code settings file of the fixture home.
func settingsFile(f registrationFixture) string {
	return filepath.Join(f.home, ".claude", "settings.json")
}

// hookCommands returns the command of each hook entry of the file, under every event, with the event name.
func hookCommands(t *testing.T, file string) map[string][]string {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("%s: %v", file, err)
	}
	commands := map[string][]string{}
	for event, groups := range document.Hooks {
		for _, group := range groups {
			for _, hook := range group.Hooks {
				commands[event] = append(commands[event], hook.Command)
			}
		}
	}
	return commands
}

// soksakCommands returns the commands of the file that carry the mark of soksak, per event.
func soksakCommands(t *testing.T, file string) map[string][]string {
	t.Helper()
	marked := map[string][]string{}
	for event, commands := range hookCommands(t, file) {
		for _, command := range commands {
			if strings.HasSuffix(command, hookMark) {
				marked[event] = append(marked[event], command)
			}
		}
	}
	return marked
}

// personHooks is the settings file that a person wrote: a model, a Stop hook, a PreToolUse hook with a matcher, and an old soksak
// entry under the Stop event that a stale install left behind.
const personHooks = `{
  "model": "opus",
  "hooks": {
    "Stop": [
      {"matcher": "", "hooks": [{"type": "command", "command": "echo person-stop"}]},
      {"matcher": "", "hooks": [{"type": "command", "command": "[ -n \"$SOKSAK_CONFIG_DIR\" ] || exit 0; exec /old/sok role identity --soksak-hook"}]}
    ],
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo person-pre"}]}
    ]
  }
}
`

// personValues is the part of a settings file that the person wrote, decoded for comparison.
func personValues(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	hooks := document["hooks"].(map[string]any)
	stop := []any{}
	for _, group := range hooks["Stop"].([]any) {
		for _, hook := range group.(map[string]any)["hooks"].([]any) {
			if !strings.HasSuffix(hook.(map[string]any)["command"].(string), hookMark) {
				stop = append(stop, group)
			}
		}
	}
	return map[string]any{"model": document["model"], "Stop": stop, "PreToolUse": hooks["PreToolUse"]}
}

// contract: cli.setup.hook-install-keeps-the-persons-hooks
func TestSetupInstallHookKeepsThePersonsHooksAndDropsStaleEntries(t *testing.T) {
	f := hookFixture(t)
	mkdirs(t, filepath.Join(f.home, ".claude"))
	writeText(t, settingsFile(f), personHooks)
	original, err := os.ReadFile(settingsFile(f))
	if err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := f.run(t, "setup", "install", "hook")
	if code != 0 {
		t.Fatalf("code %d stdout %s stderr %q", code, stdout, stderr)
	}
	after, err := os.ReadFile(settingsFile(f))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(personValues(t, original), personValues(t, after)) {
		t.Fatalf("the persons hooks changed:\n%s", after)
	}
	marked := soksakCommands(t, settingsFile(f))
	if len(marked) != 1 || len(marked["SessionStart"]) != 1 || strings.Contains(string(after), "/old/sok") {
		t.Fatalf("soksak entries %v after install:\n%s", marked, after)
	}
	want := `[ -n "$SOKSAK_CONFIG_DIR" ] || exit 0; exec ` + f.running + hookMark
	if marked["SessionStart"][0] != want {
		t.Fatalf("command %q, want %q", marked["SessionStart"][0], want)
	}
}

// contract: cli.setup.hook-install-twice-gives-identical-bytes
func TestSetupInstallHookTwiceGivesIdenticalBytes(t *testing.T) {
	f := hookFixture(t)
	mkdirs(t, filepath.Join(f.home, ".claude"))
	writeText(t, settingsFile(f), personHooks)
	if code, stdout, stderr := f.run(t, "setup", "install", "hook"); code != 0 {
		t.Fatalf("first install: code %d stdout %s stderr %q", code, stdout, stderr)
	}
	first, err := os.ReadFile(settingsFile(f))
	if err != nil {
		t.Fatal(err)
	}
	if code, stdout, stderr := f.run(t, "setup", "install", "hook"); code != 0 {
		t.Fatalf("second install: code %d stdout %s stderr %q", code, stdout, stderr)
	}
	second, err := os.ReadFile(settingsFile(f))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("second install changed the bytes:\n%s\n---\n%s", first, second)
	}
}

// contract: cli.setup.hook-remove-keeps-the-persons-hooks
func TestSetupRemoveHookRemovesOnlySoksakEntries(t *testing.T) {
	f := hookFixture(t)
	mkdirs(t, filepath.Join(f.home, ".claude"))
	// The file is in the two-space form that the install writes, so an install and a removal return it to its bytes.
	canonical := "{\n  \"model\": \"opus\",\n  \"hooks\": {\n    \"Stop\": [\n      {\n        \"matcher\": \"\",\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"echo person-stop\"\n          }\n        ]\n      }\n    ]\n  }\n}\n"
	writeText(t, settingsFile(f), canonical)
	if code, stdout, stderr := f.run(t, "setup", "install", "hook"); code != 0 {
		t.Fatalf("install: code %d stdout %s stderr %q", code, stdout, stderr)
	}
	if code, stdout, stderr := f.run(t, "setup", "remove", "hook"); code != 0 {
		t.Fatalf("remove: code %d stdout %s stderr %q", code, stdout, stderr)
	}
	after, err := os.ReadFile(settingsFile(f))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != canonical {
		t.Fatalf("removal changed the file:\n%s", after)
	}
}

// contract: cli.role.identity-outside-a-tab-prints-nothing
func TestHookCommandOutsideATabExitsZeroWithoutSok(t *testing.T) {
	f := hookFixture(t)
	mkdirs(t, filepath.Join(f.home, ".claude"))
	if code, stdout, stderr := f.run(t, "setup", "install", "hook"); code != 0 {
		t.Fatalf("install: code %d stdout %s stderr %q", code, stdout, stderr)
	}
	commands := soksakCommands(t, settingsFile(f))["SessionStart"]
	if len(commands) != 1 {
		t.Fatalf("soksak SessionStart entries %v", commands)
	}
	// sok is not on PATH and no tab environment exists: the guard exits 0 before it runs sok.
	cmd := exec.Command("/bin/sh", "-c", commands[0])
	cmd.Env = []string{"HOME=" + f.home, "PATH=/usr/bin:/bin"}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("hook command failed: %v stderr %q", err, stderr.String())
	}
	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("hook command printed stdout %q stderr %q", stdout.String(), stderr.String())
	}
}

// identityFor is the additionalContext of the identity of a tab whose role file is file (docs/spec/agent-roles.md#stable-identity).
func identityFor(file string) string {
	return "[soksak role] Your role is defined in the file " + file + ". Read the whole file before your first answer. Read the file again when a message starts with [soksak role] and says that the role changed. Do not save your role in any persistent memory. The role file is the only record of your role."
}

// contract: cli.role.identity-prints-the-identity-of-the-tab
func TestRoleIdentityPrintsTheIdentityOfTheTab(t *testing.T) {
	player := playCase(t, "role-identity")
	file := filepath.Join(player.configDir, "agents", "tab-a", "role.md")
	writeText(t, file, "role text\n")
	env := []string{"HOME=" + t.TempDir(), "PATH=/usr/bin:/bin", configDirVariable + "=" + player.configDir}
	code, stdout, stderr := runProgram(t, builtSok(t), env, "role", "identity")
	want := `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"` + identityFor(file) + `"}}` + "\n"
	if code != 0 || stdout != want || stderr != "" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.role.identity-without-a-role-prints-nothing
func TestRoleIdentityWithoutARoleFilePrintsNothing(t *testing.T) {
	player := playCase(t, "role-identity")
	env := []string{"HOME=" + t.TempDir(), "PATH=/usr/bin:/bin", configDirVariable + "=" + player.configDir}
	if code, stdout, stderr := runProgram(t, builtSok(t), env, "role", "identity"); code != 0 || stdout != "" || stderr != "" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.role.identity-outside-a-window-prints-nothing
func TestRoleIdentityOutsideAWindowPrintsNothing(t *testing.T) {
	player := playCase(t, "agent-surface-refused")
	env := []string{"HOME=" + t.TempDir(), "PATH=/usr/bin:/bin", configDirVariable + "=" + player.configDir}
	if code, stdout, stderr := runProgram(t, builtSok(t), env, "role", "identity"); code != 0 || stdout != "" || stderr != "" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// sharedHookCases reads the cases that the Go and Rust tests both run (docs/spec/cases/setup/hook-files.json).
func sharedHookCases(t *testing.T) (placeholder string, cases []struct {
	Name, Input, Install, Remove string
}) {
	t.Helper()
	data, err := os.ReadFile(repositoryFile(t, "docs/spec/cases/setup/hook-files.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Placeholder string `json:"placeholder"`
		Cases       []struct {
			Name    string `json:"name"`
			Input   string `json:"input"`
			Install string `json:"install"`
			Remove  string `json:"remove"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	for _, c := range doc.Cases {
		cases = append(cases, struct{ Name, Input, Install, Remove string }{c.Name, c.Input, c.Install, c.Remove})
	}
	return doc.Placeholder, cases
}

// contract: cli.setup.hook-files-match-the-shared-cases
func TestSetupHookFilesMatchTheSharedCases(t *testing.T) {
	placeholder, cases := sharedHookCases(t)
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			f := hookFixture(t)
			mkdirs(t, filepath.Join(f.home, ".claude"))
			writeText(t, settingsFile(f), c.Input)
			if code, stdout, stderr := f.run(t, "setup", "install", "hook"); code != 0 {
				t.Fatalf("install: code %d stdout %s stderr %q", code, stdout, stderr)
			}
			installed, err := os.ReadFile(settingsFile(f))
			if err != nil {
				t.Fatal(err)
			}
			if want := strings.ReplaceAll(c.Install, placeholder, f.running); string(installed) != want {
				t.Fatalf("install bytes\n%s\nwant\n%s", installed, want)
			}
			g := hookFixture(t)
			mkdirs(t, filepath.Join(g.home, ".claude"))
			writeText(t, settingsFile(g), c.Input)
			if code, stdout, stderr := g.run(t, "setup", "remove", "hook"); code != 0 {
				t.Fatalf("remove: code %d stdout %s stderr %q", code, stdout, stderr)
			}
			removed, err := os.ReadFile(settingsFile(g))
			if err != nil {
				t.Fatal(err)
			}
			if string(removed) != c.Remove {
				t.Fatalf("remove bytes\n%s\nwant\n%s", removed, c.Remove)
			}
		})
	}
}

// contract: cli.setup.hook-escapes-the-command-as-encoding-json-does
func TestSetupInstallHookEscapesTheCommandAsEncodingJSONDoes(t *testing.T) {
	f := hookFixture(t)
	mkdirs(t, filepath.Join(f.home, ".claude"))
	sok := copyExecutable(t, builtSok(t), filepath.Join(t.TempDir(), "A&<B>.app", "Contents", "MacOS", "sok"))
	env := []string{"HOME=" + f.home, "PATH=/usr/bin:/bin"}
	if code, stdout, stderr := runProgram(t, sok, env, "setup", "install", "hook"); code != 0 {
		t.Fatalf("code %d stdout %s stderr %q", code, stdout, stderr)
	}
	data, err := os.ReadFile(settingsFile(f))
	if err != nil {
		t.Fatal(err)
	}
	for _, escape := range []string{`\u0026`, `\u003c`, `\u003e`} {
		if !strings.Contains(string(data), escape) {
			t.Fatalf("the command has no %s:\n%s", escape, data)
		}
	}
	if want := `[ -n "$SOKSAK_CONFIG_DIR" ] || exit 0; exec ` + "'" + sok + "'" + hookMark; soksakCommands(t, settingsFile(f))["SessionStart"][0] != want {
		t.Fatalf("command %q, want %q", soksakCommands(t, settingsFile(f))["SessionStart"][0], want)
	}
}
