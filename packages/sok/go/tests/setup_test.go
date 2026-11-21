package tests

// Checks the MCP registration and the setup parts (docs/spec/cli.md#mcp-registration, docs/spec/cli.md#setup-parts) with the
// fixture program of the claude command (docs/spec/cases/setup/fixture.sh) in a disposable home.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

type mcpInstall struct {
	Registration struct {
		Type    string         `json:"type"`
		Command string         `json:"command"`
		Args    []string       `json:"args"`
		Env     map[string]any `json:"env"`
	} `json:"registration"`
	State string `json:"state"`
}

func decodeInstall(t *testing.T, stdout string) mcpInstall {
	t.Helper()
	var out mcpInstall
	if err := json.Unmarshal([]byte(stdout), &out); err != nil {
		t.Fatalf("mcp install printed %q: %v", stdout, err)
	}
	return out
}

type setupPart struct {
	Part    string `json:"part"`
	File    string `json:"file"`
	State   string `json:"state"`
	Step    string `json:"step"`
	Reason  string `json:"reason,omitempty"`
	Error   string `json:"error,omitempty"`
	Changed *bool  `json:"changed,omitempty"`
}

func decodeParts(t *testing.T, stdout string) []setupPart {
	t.Helper()
	var out struct {
		Parts []setupPart `json:"parts"`
	}
	if err := json.Unmarshal([]byte(stdout), &out); err != nil {
		t.Fatalf("setup printed %q: %v", stdout, err)
	}
	return out.Parts
}

// describeParts writes each part as `<part> <state> <reason or error>` on its own line.
func describeParts(parts []setupPart) string {
	lines := []string{}
	for _, part := range parts {
		line := part.Part + " " + part.State
		if part.Reason != "" {
			line += " " + part.Reason
		}
		if part.Error != "" {
			line += " " + part.Error
		}
		if part.Changed != nil {
			line += fmt.Sprintf(" changed=%v", *part.Changed)
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// registrationFixture is a disposable home with the claude fixture and a sok of an application bundle on PATH.
type registrationFixture struct {
	agentHome
	claudeDir string
	sok       string
	// running is the sok of the application bundle that runs the commands of the test (runInBundle).
	running string
	config  string
}

func newRegistrationFixture(t *testing.T) registrationFixture {
	t.Helper()
	h := newAgentHome(t)
	claudeDir := setupFixture(t, "claude")
	sok := bundleSok(t, repositoryFile(t, "docs/spec/cases/setup/fixture.sh"), "First")
	t.Setenv("PATH", filepath.Dir(sok)+string(os.PathListSeparator)+claudeDir)
	running := bundleSok(t, testExecutable(t), "Running")
	return registrationFixture{agentHome: h, claudeDir: claudeDir, sok: sok, running: running, config: filepath.Join(h.home, ".claude.json")}
}

// run runs the command in the application bundle of the fixture, so that the running sok is a sok of a bundle.
func (f registrationFixture) run(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	return runInBundle(t, f.running, args...)
}

// sokArgsVariable passes the arguments of a sok run by runInBundle.
const sokArgsVariable = "SOKSAK_TEST_SOK_ARGS"

// runInBundle runs the sok of the test from bundle, a copy of the test binary in an application bundle folder, so that the
// running sok is a sok of an application bundle as on macOS (docs/spec/cli.md#mcp-registration). The copy runs
// TestSokHelperProcess, which calls sok.Run with the arguments of the test.
func runInBundle(t *testing.T, bundle string, args ...string) (int, string, string) {
	t.Helper()
	encoded, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bundle, "-test.run=^TestSokHelperProcess$")
	cmd.Env = append(os.Environ(), sokArgsVariable+"="+string(encoded))
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	code := 0
	if err := cmd.Run(); err != nil {
		exit, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatal(err)
		}
		code = exit.ExitCode()
	}
	return code, stdout.String(), stderr.String()
}

// TestSokHelperProcess is the sok that runInBundle runs; it returns at once in the test run that does not run it.
// contract: cli.mcp.install-registers-the-running-sok
func TestSokHelperProcess(t *testing.T) {
	encoded := os.Getenv(sokArgsVariable)
	if encoded == "" {
		return
	}
	var args []string
	if err := json.Unmarshal([]byte(encoded), &args); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(sok.Run(args, os.Stdout, os.Stderr, sok.Options{Identifier: "com.soksak.test", CoreVersion: "0.0.2"}))
}

// writeRegistration writes the configuration file of the claude command with the entry soksak.
func writeRegistration(t *testing.T, file string, entry string) {
	t.Helper()
	writeText(t, file, `{"numStartups": 3, "mcpServers": {"other": {"type": "stdio", "command": "x"}, "soksak": `+entry+`}}`)
}

// contract: cli.mcp.install-requires-the-claude-command
func TestMcpInstallRequiresTheClaudeCommand(t *testing.T) {
	f := newRegistrationFixture(t)
	t.Setenv("PATH", filepath.Dir(f.running))
	writeText(t, f.config, `{"numStartups": 3}`)
	code, stdout, stderr := f.run(t, "mcp", "install")
	want := fmt.Sprintf("sok: the claude command is not on PATH; register the MCP server \"%s mcp\" (standard input and output) with the agent\n", f.running)
	if code != 1 || stdout != "" || stderr != want {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	if fileText(t, f.config) != `{"numStartups": 3}` || f.commands(t) != nil {
		t.Fatalf("file %q commands %v", fileText(t, f.config), f.commands(t))
	}
}

// contract: cli.mcp.install-registers-once
func TestMcpInstallRegistersOnce(t *testing.T) {
	f := newRegistrationFixture(t)
	code, stdout, stderr := f.run(t, "mcp", "install")
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	out := decodeInstall(t, stdout)
	if out.State != "registered" || out.Registration.Type != "stdio" || out.Registration.Command != f.running ||
		fmt.Sprint(out.Registration.Args) != "[mcp]" || strings.Contains(stdout, "running") {
		t.Fatalf("output %s", stdout)
	}
	if !strings.HasSuffix(stdout, "\"state\": \"registered\"\n}\n") || !strings.HasPrefix(stdout, "{\n  \"registration\": {\n    \"type\": \"stdio\",") {
		t.Fatalf("output members out of order: %s", stdout)
	}
	want := "claude mcp add --scope user soksak -- " + f.running + " mcp"
	if commands := f.commands(t); fmt.Sprint(commands) != "["+want+"]" {
		t.Fatalf("commands %q, want %q", commands, want)
	}
	code, stdout, stderr = f.run(t, "mcp", "install")
	if code != 0 || decodeInstall(t, stdout).State != "current" || len(f.commands(t)) != 1 {
		t.Fatalf("code %d stdout %q stderr %q commands %v", code, stdout, stderr, f.commands(t))
	}
}

// contract: cli.mcp.install-registers-the-running-sok
func TestMcpInstallRegistersTheRunningSok(t *testing.T) {
	program := builtSok(t)
	f := newRegistrationFixture(t)
	first := bundleSok(t, program, "One")
	second := bundleSok(t, program, "Two")
	t.Setenv("PATH", strings.Join([]string{filepath.Dir(first), filepath.Dir(second), f.claudeDir}, string(os.PathListSeparator)))
	code, stdout, stderr := runProgram(t, second, environment(), "mcp", "install")
	out := decodeInstall(t, stdout)
	if code != 0 || out.State != "registered" || out.Registration.Command != second || strings.Contains(stdout, "running") {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	_, stdout, stderr = runProgram(t, second, environment(), "setup", "check")
	parts := decodeParts(t, stdout)
	mcp := parts[len(parts)-1]
	if mcp.Part != "mcp" || mcp.State != "ok" || mcp.File != f.config {
		t.Fatalf("parts %s stderr %q", stdout, stderr)
	}
	// A second install from the same bundle changes nothing.
	code, stdout, stderr = runProgram(t, second, environment(), "mcp", "install")
	out = decodeInstall(t, stdout)
	if code != 0 || out.State != "current" || out.Registration.Command != second {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	// An install from the first bundle replaces the registration of the second one.
	code, stdout, stderr = runProgram(t, first, environment(), "mcp", "install")
	out = decodeInstall(t, stdout)
	if code != 0 || out.State != "registered" || out.Registration.Command != first {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.mcp.install-registers-a-moved-executable-again
func TestMcpInstallRegistersAMovedExecutableAgain(t *testing.T) {
	for _, entry := range []string{
		`{"type": "stdio", "command": "/Applications/Old.app/Contents/MacOS/sok", "args": ["mcp"], "env": {}}`,
		`{"type": "stdio", "command": "%s", "args": ["mcp", "--window", "main"]}`,
		`{"type": "stdio", "command": "%s", "args": ["mcp"], "env": {"A": "1"}}`,
	} {
		f := newRegistrationFixture(t)
		if strings.Contains(entry, "%s") {
			entry = fmt.Sprintf(entry, f.running)
		}
		writeRegistration(t, f.config, entry)
		code, stdout, stderr := f.run(t, "mcp", "install")
		if code != 0 || decodeInstall(t, stdout).State != "registered" {
			t.Fatalf("%s: code %d stdout %q stderr %q", entry, code, stdout, stderr)
		}
		want := []string{"claude mcp remove --scope user soksak", "claude mcp add --scope user soksak -- " + f.running + " mcp"}
		if commands := f.commands(t); fmt.Sprint(commands) != fmt.Sprint(want) {
			t.Fatalf("%s: commands %q, want %q", entry, commands, want)
		}
	}
}

// contract: cli.mcp.install-reads-the-claude-config-dir
func TestMcpInstallReadsTheClaudeConfigDir(t *testing.T) {
	f := newRegistrationFixture(t)
	dir := filepath.Join(f.home, "claude-config")
	mkdirs(t, dir)
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeRegistration(t, filepath.Join(dir, ".claude.json"), fmt.Sprintf(`{"type": "stdio", "command": %q, "args": ["mcp"]}`, f.running))
	code, stdout, stderr := f.run(t, "mcp", "install")
	if code != 0 || decodeInstall(t, stdout).State != "current" || f.commands(t) != nil || fileText(t, f.config) != "" {
		t.Fatalf("code %d stdout %q stderr %q commands %v", code, stdout, stderr, f.commands(t))
	}
	_, stdout, _ = f.run(t, "setup", "check")
	parts := decodeParts(t, stdout)
	if mcp := parts[len(parts)-2]; mcp.Part != "mcp" || mcp.File != filepath.Join(dir, ".claude.json") || mcp.State != "ok" {
		t.Fatalf("parts %s", stdout)
	}
}

// contract: cli.mcp.install-reports-claude-failures
func TestMcpInstallReportsClaudeFailures(t *testing.T) {
	f := newRegistrationFixture(t)
	t.Setenv("SETUP_FIXTURE_FAIL", "add")
	if code, _, stderr := f.run(t, "mcp", "install"); code != 1 || stderr != "sok: claude mcp add failed with status 7: fixture add refused\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	writeRegistration(t, f.config, `{"type": "stdio", "command": "/old/sok", "args": ["mcp"]}`)
	if code, _, stderr := f.run(t, "mcp", "install"); code != 1 || stderr != "sok: claude mcp add failed with status 7: fixture add refused; the earlier registration /old/sok was removed\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	writeRegistration(t, f.config, `{"type": "stdio", "command": "/old/sok", "args": ["mcp"]}`)
	t.Setenv("SETUP_FIXTURE_FAIL", "remove")
	if code, _, stderr := f.run(t, "mcp", "install"); code != 1 || stderr != "sok: claude mcp remove failed with status 7: fixture remove refused\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	t.Setenv("SETUP_FIXTURE_FAIL", "")
	t.Setenv("SETUP_FIXTURE_SKIP_WRITE", "1")
	os.Remove(f.config)
	if code, _, stderr := f.run(t, "mcp", "install"); code != 1 || stderr != "sok: claude mcp add did not write the registration to "+f.config+"\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	before := len(f.commands(t))
	for text, position := range map[string]string{"{not json": "line 1 column 2", "{\n  \"a\": nope}": "line 2 column 9", "{": "line 1 column 1"} {
		writeText(t, f.config, text)
		want := "sok: " + f.config + " is not valid JSON at " + position + "\n"
		if code, _, stderr := f.run(t, "mcp", "install"); code != 1 || stderr != want || len(f.commands(t)) != before {
			t.Fatalf("%q: code %d stderr %q, want %q", text, code, stderr, want)
		}
	}
}

// partsFixture is a registration fixture with an agent folder.
func partsFixture(t *testing.T) (registrationFixture, string) {
	t.Helper()
	f := newRegistrationFixture(t)
	mkdirs(t, filepath.Join(f.home, ".claude"))
	return f, filepath.Join(f.home, ".claude", "skills", "soksak", "SKILL.md")
}

// contract: cli.setup.check-reports-each-part
func TestSetupCheckReportsEachPart(t *testing.T) {
	f, skill := partsFixture(t)
	running := f.running
	code, stdout, stderr := f.run(t, "setup", "check")
	parts := decodeParts(t, stdout)
	if code != 1 || describeParts(parts) != "skill missing absent\nmcp missing absent\nhook missing absent" {
		t.Fatalf("code %d parts %s", code, stdout)
	}
	if parts[0].File != skill || parts[1].File != f.config || parts[0].Step != running+" skill install" || parts[1].Step != running+" mcp install" {
		t.Fatalf("parts %s", stdout)
	}
	settings := filepath.Join(f.home, ".claude", "settings.json")
	if want := fmt.Sprintf("sok: setup parts are not current: skill %s, mcp %s, hook %s\n", skill, f.config, settings); stderr != want {
		t.Fatalf("stderr %q, want %q", stderr, want)
	}
	if !strings.HasPrefix(stdout, "{\n  \"parts\": [\n    {\n      \"part\": \"skill\",\n      \"file\": ") {
		t.Fatalf("members out of order: %s", stdout)
	}
	// Each part current.
	writeText(t, skill, skillSource(t))
	writeRegistration(t, f.config, fmt.Sprintf(`{"type": "stdio", "command": %q, "args": ["mcp"], "env": {}}`, f.running))
	if code, stdout, stderr := f.run(t, "setup", "install", "hook"); code != 0 {
		t.Fatalf("install hook: code %d stdout %s stderr %q", code, stdout, stderr)
	}
	if code, stdout, stderr := f.run(t, "setup", "check"); code != 0 || stderr != "" || describeParts(decodeParts(t, stdout)) != "skill ok\nmcp ok\nhook ok" {
		t.Fatalf("code %d stdout %s stderr %q", code, stdout, stderr)
	}
	// Each part differs.
	writeText(t, skill, "edited\n")
	writeRegistration(t, f.config, `{"type": "stdio", "command": "/elsewhere/sok", "args": ["mcp"]}`)
	writeText(t, filepath.Join(f.home, ".claude", "settings.json"), `{"hooks": {"SessionStart": [{"matcher": "", "hooks": [{"type": "command", "command": "[ -n \"$SOKSAK_CONFIG_DIR\" ] || exit 0; exec /elsewhere/sok role identity --soksak-hook"}]}]}}`+"\n")
	if code, stdout, _ := f.run(t, "setup", "check"); code != 1 || describeParts(decodeParts(t, stdout)) != "skill missing differs\nmcp missing differs\nhook missing differs" {
		t.Fatalf("code %d stdout %s", code, stdout)
	}
	// A part that cannot be read is an error with its text.
	if err := os.Chmod(skill, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(skill, 0o644) })
	writeText(t, f.config, "{not json")
	_, stdout, _ = f.run(t, "setup", "check")
	parts = decodeParts(t, stdout)
	if parts[0].State != "error" || parts[0].Error != skill+": permission denied" || parts[1].State != "error" || parts[1].Error != f.config+" is not valid JSON at line 1 column 2" {
		t.Fatalf("parts %s", stdout)
	}
	// The check changed no file.
	if fileText(t, f.config) != "{not json" || f.commands(t) != nil {
		t.Fatalf("the check changed a file: %q %v", fileText(t, f.config), f.commands(t))
	}
	// Without an agent folder and without the claude command, the parts that do not apply are not listed.
	os.RemoveAll(filepath.Join(f.home, ".claude"))
	t.Setenv("PATH", filepath.Dir(f.running))
	if _, stdout, _ := f.run(t, "setup", "check"); describeParts(decodeParts(t, stdout)) != "" {
		t.Fatalf("parts %s", stdout)
	}
}

// contract: cli.setup.check-reports-each-part
func TestSetupStepsQuoteTheSok(t *testing.T) {
	program := builtSok(t)
	newRegistrationFixture(t)
	quoted := copyExecutable(t, program, filepath.Join(t.TempDir(), "It's here.app", "Contents", "MacOS", "sok"))
	_, stdout, stderr := runProgram(t, quoted, environment(), "setup", "check")
	parts := decodeParts(t, stdout)
	want := `'` + strings.ReplaceAll(quoted, `'`, `'\''`) + `' mcp install`
	if mcp := parts[len(parts)-1]; mcp.Part != "mcp" || mcp.Step != want {
		t.Fatalf("parts %s stderr %q, want the step %q", stdout, stderr, want)
	}
}

// contract: cli.setup.install-installs-missing-parts
func TestSetupInstallInstallsMissingParts(t *testing.T) {
	f, skill := partsFixture(t)
	// Named kinds limit the install to those kinds.
	code, stdout, stderr := f.run(t, "setup", "install", "skill")
	if code != 0 || describeParts(decodeParts(t, stdout)) != "skill ok changed=true\nmcp missing absent changed=false\nhook missing absent changed=false" || f.commands(t) != nil {
		t.Fatalf("code %d stdout %s stderr %q", code, stdout, stderr)
	}
	writeText(t, skill, "edited\n")
	code, stdout, stderr = f.run(t, "setup", "install")
	if code != 0 || describeParts(decodeParts(t, stdout)) != "skill ok changed=true\nmcp ok changed=true\nhook ok changed=true" {
		t.Fatalf("code %d stdout %s stderr %q", code, stdout, stderr)
	}
	code, stdout, stderr = f.run(t, "setup", "install")
	if code != 0 || describeParts(decodeParts(t, stdout)) != "skill ok changed=false\nmcp ok changed=false\nhook ok changed=false" || len(f.commands(t)) != 1 {
		t.Fatalf("code %d stdout %s stderr %q commands %v", code, stdout, stderr, f.commands(t))
	}
	if code, _, stderr := f.run(t, "setup", "install", "nothing"); code != 2 || !strings.HasPrefix(stderr, "sok: unknown setup part: nothing\n") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

// contract: cli.setup.environment-prints-the-variables
func TestSetupEnvironmentPrintsTheVariables(t *testing.T) {
	t.Setenv("HOME", `/home/a "b"`)
	t.Setenv("PATH", "/x:/y")
	t.Setenv("OTHER", "a=b")
	unsetenv(t, "CLAUDE_CONFIG_DIR")
	code, stdout, stderr := run("setup", "environment")
	if code != 0 || stderr != "" || !strings.HasPrefix(stdout, `{"HOME":"/home/a \"b\"","PATH":"/x:/y","CLAUDE_CONFIG_DIR":null,"environment":{`) {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	var line sok.AgentEnvironment
	if err := json.Unmarshal([]byte(stdout), &line); err != nil {
		t.Fatal(err)
	}
	// environment holds every variable of the run, also one that the setup operations do not read.
	if line.Variables["HOME"] != `/home/a "b"` || line.Variables["PATH"] != "/x:/y" || line.Variables["OTHER"] != "a=b" {
		t.Fatalf("environment %v", line.Variables)
	}
	if _, present := line.Variables["CLAUDE_CONFIG_DIR"]; present {
		t.Fatalf("environment %v holds CLAUDE_CONFIG_DIR, which is not set", line.Variables)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	unsetenv(t, "HOME")
	if _, stdout, _ := run("setup", "environment"); !strings.HasPrefix(stdout, `{"HOME":null,"PATH":"/x:/y","CLAUDE_CONFIG_DIR":"","environment":{`) {
		t.Fatalf("stdout %q", stdout)
	}
}
