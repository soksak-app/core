package host_test

// The setup parts in the application (docs/spec/cli.md#agents-in-the-application): the host reads the environment of the login
// shell, brings the skill current at start and runs the setup operations of the setup library. The tests run the real login shell
// /bin/zsh with start files in a disposable home, the sok of this module built once, and the fixture program of the claude command
// (docs/spec/cases/setup/fixture.sh).

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/tests/support"
	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// The login shell of the tests: zsh reads .zprofile and .zshrc of the disposable home as a login and interactive shell.
const setupShell = "/bin/zsh"

// setupSok builds the sok of this module into a temporary folder of the test, before the test changes HOME, so the build uses the
// build cache of the environment that the test process started with.
func setupSok(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sok")
	build := exec.Command("go", "build", "-o", path, "github.com/soksak-app/core/packages/sok/go/src/cmd/sok")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build sok: %v\n%s", err, output)
	}
	return path
}

// zshLogin is the platform of this system with /bin/zsh as the login shell, because the test cannot change the user database.
type zshLogin struct{ platform.Platform }

func (zshLogin) LoginShell() (string, error) { return setupShell, nil }

// setupFile returns a file of the repository, found by walking up from this source file.
func setupFile(t *testing.T, relative string) string {
	t.Helper()
	_, here, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("the source file of the setup tests is unknown")
	}
	for dir := filepath.Dir(here); ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, relative)); err == nil {
			return filepath.Join(dir, relative)
		}
		if filepath.Dir(dir) == dir {
			t.Fatalf("no folder above %s holds %s", here, relative)
		}
	}
}

// copyTo copies the file to path with mode 0755 and returns the canonical path of the copy.
func copyTo(t *testing.T, source, path string) string {
	t.Helper()
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o755); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return canonical
}

// setupHome is a disposable home whose login shell finds the claude fixture and the sok of an application bundle only through
// the PATH that its .zprofile sets, and sets CLAUDE_CONFIG_DIR.
type setupHome struct {
	home, sok, log, config string
}

func newSetupHome(t *testing.T, zshrc string) setupHome {
	t.Helper()
	built := setupSok(t)
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// The space in the bundle name makes the step quote <sok>.
	bundle := copyTo(t, built, filepath.Join(home, "Applications", "Fixture App.app", "Contents", "MacOS", "sok"))
	// The first run of a new executable can wait at its start while the system checks the file, so the test runs it once before
	// the bound of the login shell read applies.
	if output, err := exec.Command(bundle, "setup", "environment").CombinedOutput(); err != nil {
		t.Fatalf("the first run of %s: %v\n%s", bundle, err, output)
	}
	tools := filepath.Join(home, "tools")
	// The fixture as sudo records a run of sudo, which no operation of the application may start.
	for _, name := range []string{"claude", "sudo"} {
		copyTo(t, setupFile(t, "docs/spec/cases/setup/fixture.sh"), filepath.Join(tools, name))
	}
	config := filepath.Join(home, "agent-config")
	for _, dir := range []string{filepath.Join(home, ".claude"), config} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	log := filepath.Join(t.TempDir(), "commands.log")
	// The login PATH leaves out every directory that holds a codex command, so the registration with codex runs the same way on any
	// machine; the codex registration has its own case (docs/spec/cli.md#mcp-registration).
	zprofile := fmt.Sprintf("export PATH=%q:%q:$PATH\nwithout=\"\"\nfor dir in ${(s,:,)PATH}; do [ -x \"$dir/codex\" ] || without=\"$without:$dir\"; done\nexport PATH=\"${without#:}\"\nexport CLAUDE_CONFIG_DIR=%q\n", filepath.Dir(bundle), tools, config)
	for name, text := range map[string]string{".zprofile": zprofile, ".zshrc": zshrc} {
		if err := os.WriteFile(filepath.Join(home, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	for _, name := range []string{"ZDOTDIR", "CLAUDE_CONFIG_DIR", "SETUP_FIXTURE_FAIL", "SETUP_FIXTURE_SKIP_WRITE"} {
		t.Setenv(name, "")
		os.Unsetenv(name)
	}
	// The commands that the setup library starts inherit the environment of the host process with the three variables of the login
	// shell, so the log of the fixture is named in the environment of the test process.
	t.Setenv("SETUP_FIXTURE_LOG", log)
	return setupHome{home: home, sok: bundle, log: log, config: config}
}

// commands are the lines of the fixture log: the external commands that ran.
func (h setupHome) commands(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile(h.log)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
}

// setups returns the setup operations of the bundle sok of the home with the login shell, and the channel that receives each
// setup-changed.
func (h setupHome) setups(t *testing.T) (*host.Setups, chan struct{}) {
	t.Helper()
	changed := make(chan struct{}, 8)
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	setups, err := host.NewSetups(h.sok, "com.soksak.test", zshLogin{system}, func() { changed <- struct{}{} })
	if err != nil {
		t.Fatal(err)
	}
	return setups, changed
}

// pidOf reads the process id that a start file wrote to the file.
func pidOf(t *testing.T, file string) int {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

// waitExited waits for the exit of the process pid through the process exit event of kqueue; a process that already ended is
// refused by the registration with ESRCH.
func waitExited(t *testing.T, pid int) {
	t.Helper()
	queue, err := unix.Kqueue()
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(queue)
	change := unix.Kevent_t{Ident: uint64(pid), Filter: unix.EVFILT_PROC, Flags: unix.EV_ADD | unix.EV_ONESHOT, Fflags: unix.NOTE_EXIT}
	events := make([]unix.Kevent_t, 1)
	if _, err := unix.Kevent(queue, []unix.Kevent_t{change}, events, nil); err != nil && !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("watch the exit of %d: %v", pid, err)
	}
}

// contract: setup.host.reads-the-login-shell-environment, setup.host.start-brings-the-skill-current, setup.host.start-brings-the-agent-parts-current
func TestSetupReadsTheLoginShellEnvironmentAndBringsTheSkillCurrent(t *testing.T) {
	// The start files print before the line, and a process that they start holds the output open after it.
	h := newSetupHome(t, "echo start-file output\necho start-file error >&2\nsleep 600 &\necho $! > \"$HOME/background.pid\"\n")
	differing := filepath.Join(h.config, "skills", "soksak", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(differing), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(differing, []byte("an earlier skill\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	setups, changed := h.setups(t)
	setups.Start()
	setups.Start()
	<-changed
	waitExited(t, pidOf(t, filepath.Join(h.home, "background.pid")))
	for _, file := range []string{filepath.Join(h.home, ".claude", "skills", "soksak", "SKILL.md"), differing} {
		data, err := os.ReadFile(file)
		if err != nil || string(data) != sok.SkillText {
			t.Fatalf("the start did not bring %s current: %v", file, err)
		}
	}
	// The start registers the sok of the bundle with the claude command once and runs no sudo.
	if commands, want := h.commands(t), []string{"claude mcp add --scope user soksak -- " + h.sok + " mcp"}; !slices.Equal(commands, want) {
		t.Fatalf("the start ran %q, not %q", commands, want)
	}
	parts, err := setups.State()
	if err != nil {
		t.Fatal(err)
	}
	step := "'" + h.sok + "'"
	var got []string
	for _, part := range parts.Parts {
		got = append(got, strings.Join([]string{part.Part, part.File, part.State, part.Reason, part.Step}, " | "))
	}
	want := []string{
		"skill | " + filepath.Join(h.home, ".claude", "skills", "soksak", "SKILL.md") + " | ok |  | " + step + " skill install",
		"skill | " + differing + " | ok |  | " + step + " skill install",
		"mcp | " + filepath.Join(h.config, ".claude.json") + " | ok |  | " + step + " mcp install",
		"hook | " + filepath.Join(h.home, ".claude", "settings.json") + " | ok |  | " + step + " setup install hook",
		"hook | " + filepath.Join(h.config, "settings.json") + " | ok |  | " + step + " setup install hook",
	}
	// The user PATH registration applies on macOS and preserves the existing command.
	if len(parts.Parts) > 0 && parts.Parts[0].Part == "path" {
		if path := parts.Parts[0]; path.State != "ok" || path.Enabled == nil || !*path.Enabled || path.Step != "" {
			t.Fatalf("the user PATH registration is %+v", path)
		}
		got = got[1:]
	}
	if !slices.Equal(got, want) {
		t.Fatalf("the parts are\n%s\nnot\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// contract: setup.host.reconciles-user-path
func TestSetupRegistersUserPathOnStart(t *testing.T) {
	h := newSetupHome(t, "export PATH=/usr/bin:/bin\n")
	setups, changed := h.setups(t)
	setups.Start()
	<-changed
	entry := filepath.Join(h.home, ".local", "bin", "sok")
	resolved, err := filepath.EvalSymlinks(entry)
	if err != nil || resolved != h.sok {
		t.Fatalf("the user PATH link resolved to %q, want %q: %v", resolved, h.sok, err)
	}
	if commands := h.commands(t); len(commands) != 0 {
		t.Fatalf("the start ran %q", commands)
	}
	parts, err := setups.State()
	if err != nil || parts.Parts[0].State != "ok" {
		t.Fatalf("the fresh shell did not resolve the user registration: %+v, %v", parts, err)
	}
	disabled := false
	parts, err = setups.Change(host.SetupChangeRequest{Part: "path", Enabled: &disabled})
	if err != nil || parts.Parts[0].Enabled == nil || *parts.Parts[0].Enabled {
		t.Fatalf("the registration was not disabled: %+v, %v", parts, err)
	}
	restarted, restartedChanged := h.setups(t)
	restarted.Start()
	<-restartedChanged
	parts, err = restarted.State()
	if err != nil || parts.Parts[0].Enabled == nil || *parts.Parts[0].Enabled {
		t.Fatalf("restart changed the disabled preference: %+v, %v", parts, err)
	}
	if _, err := os.Lstat(entry); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("restart did not leave the owned link absent: %v", err)
	}
}

// contract: setup.host.start-brings-the-skill-current
func TestSetupRecordsASkillFileThatCannotBeWritten(t *testing.T) {
	log := support.UseEventLog(t)
	h := newSetupHome(t, "")
	// Both agent folders hold a differing skill file in a folder that cannot be written; each one is recorded.
	var want []string
	for _, agentFolder := range []string{filepath.Join(h.home, ".claude"), h.config} {
		folder := filepath.Join(agentFolder, "skills", "soksak")
		file := filepath.Join(folder, "SKILL.md")
		if err := os.MkdirAll(folder, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("an earlier skill\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(folder, 0o555); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(folder, 0o755) })
		want = append(want, "error "+file+" permission denied")
	}
	setups, changed := h.setups(t)
	setups.Start()
	<-changed
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var recorded []string
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "host.setup.skill" {
			fields := event["fields"].(map[string]any)
			recorded = append(recorded, fmt.Sprintf("%s %v %v", event["level"], fields["file"], fields["reason"]))
		}
	}
	if !slices.Equal(recorded, want) {
		t.Fatalf("the start recorded %q, not %q", recorded, want)
	}
	for _, command := range h.commands(t) {
		if strings.HasPrefix(command, "sudo ") {
			t.Fatalf("the start ran %q", command)
		}
	}
}

// contract: setup.host.start-brings-the-agent-parts-current
func TestSetupRecordsAnAgentPartThatTheStartCannotInstall(t *testing.T) {
	log := support.UseEventLog(t)
	h := newSetupHome(t, "")
	t.Setenv("SETUP_FIXTURE_FAIL", "add")
	setups, changed := h.setups(t)
	setups.Start()
	<-changed
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var recorded []string
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "host.setup.install" {
			recorded = append(recorded, fmt.Sprintf("%s %v", event["level"], event["fields"].(map[string]any)["reason"]))
		}
	}
	if len(recorded) != 1 || !strings.HasPrefix(recorded[0], "error setup parts are not current: mcp "+filepath.Join(h.config, ".claude.json")) {
		t.Fatalf("the start recorded %q, not one error that names the mcp part", recorded)
	}
	// The hooks do not depend on the registration, so the start installs them although the registration failed.
	parts, err := setups.State()
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range parts.Parts {
		if part.Part == "hook" && part.State != "ok" {
			t.Fatalf("the start left the hook part %+v", part)
		}
	}
}

// contract: setup.host.reads-the-login-shell-environment
func TestSetupFailsWhenTheLoginShellGivesNoEnvironment(t *testing.T) {
	t.Run("a shell that ends before the line", func(t *testing.T) {
		h := newSetupHome(t, "echo start-file output\necho boom >&2\necho second >&2\nexit 3\n")
		setups, changed := h.setups(t)
		setups.Start()
		<-changed
		want := "login shell " + setupShell + ": exit status 3: boom"
		if _, err := setups.State(); err == nil || err.Error() != want {
			t.Fatalf("setupState answered %v, not %s", err, want)
		}
		if _, err := setups.Install(host.SetupInstallRequest{Parts: []any{"skill"}}); err == nil || err.Error() != want {
			t.Fatalf("setupInstall answered %v, not %s", err, want)
		}
	})
	t.Run("a shell that waits", func(t *testing.T) {
		gate := filepath.Join(t.TempDir(), "gate")
		if err := unix.Mkfifo(gate, 0o600); err != nil {
			t.Fatal(err)
		}
		h := newSetupHome(t, fmt.Sprintf("echo start-file output\necho $$ > \"$HOME/shell.pid\"\nread line < %q\n", gate))
		setups, changed := h.setups(t)
		setups.Start()
		<-changed
		want := "login shell " + setupShell + ": no environment within 10 s"
		if _, err := setups.State(); err == nil || err.Error() != want {
			t.Fatalf("setupState answered %v, not %s", err, want)
		}
		waitExited(t, pidOf(t, filepath.Join(h.home, "shell.pid")))
	})
}

// contract: setup.host.state-and-install
func TestSetupInstallsTheSkillAndTheRegistrationOneAtATime(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "gate")
	if err := unix.Mkfifo(gate, 0o600); err != nil {
		t.Fatal(err)
	}
	// The shell waits at the gate, so the first install holds the setup operation while it waits for the environment.
	h := newSetupHome(t, fmt.Sprintf("if [ ! -e \"$HOME/setup-read\" ]; then\n  read line < %q\n  : > \"$HOME/setup-read\"\nfi\n", gate))
	setups, changed := h.setups(t)
	setups.Start()
	type answer struct {
		parts sok.SetupParts
		err   error
	}
	answers := make(chan answer, 2)
	for range 2 {
		go func() {
			parts, err := setups.Install(host.SetupInstallRequest{Parts: []any{"skill", "mcp"}})
			answers <- answer{parts, err}
		}()
	}
	refused := <-answers
	if refused.err == nil || refused.err.Error() != "another setup operation is running" {
		t.Fatalf("the second install answered %v", refused.err)
	}
	if err := os.WriteFile(gate, []byte("open\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	installed := <-answers
	if installed.err != nil {
		t.Fatal(installed.err)
	}
	var states []string
	for _, part := range installed.parts.Parts {
		if part.Part != "path" {
			states = append(states, fmt.Sprintf("%s %s %v", part.Part, part.State, *part.Changed))
		}
	}
	// The install lists every part as the check reads it afterwards. The start, which ends before the install takes the environment,
	// wrote the skill files, the registration and the hooks, so the install changes nothing.
	if want := []string{"skill ok false", "skill ok false", "mcp ok false", "hook ok false", "hook ok false"}; !slices.Equal(states, want) {
		t.Fatalf("the install answered %q, not %q", states, want)
	}
	if commands, want := h.commands(t), []string{"claude mcp add --scope user soksak -- " + h.sok + " mcp"}; !slices.Equal(commands, want) {
		t.Fatalf("the start and the install ran %q, not %q", commands, want)
	}
	// One setup-changed after the skill write at start and one after the install.
	<-changed
	<-changed
	state, err := setups.State()
	if err != nil {
		t.Fatal(err)
	}
	var mcpState string
	for _, part := range state.Parts {
		if part.Part == "mcp" {
			mcpState = part.State
		}
	}
	if mcpState != "ok" {
		t.Fatalf("setupState after the install reports mcp as %q", mcpState)
	}

	want := "the path entry needs administrator rights: run sudo '" + h.sok + "' path install in a terminal"
	if _, err := setups.Install(host.SetupInstallRequest{Parts: []any{"path", "skill"}}); err == nil || err.Error() != want {
		t.Fatalf("an install of the path entry answered %v, not %s", err, want)
	}
	for _, parts := range []any{nil, []any{}, []any{"skill", "skill"}, "skill", []any{1}} {
		if _, err := setups.Install(host.SetupInstallRequest{Parts: parts}); err == nil || err.Error() != "parts must be a non-empty list of setup parts without repetition" {
			t.Errorf("parts %v answered %v", parts, err)
		}
	}
	if _, err := setups.Install(host.SetupInstallRequest{Parts: []any{"other"}}); err == nil || err.Error() != "unknown setup part: other" {
		t.Errorf("an unknown part answered %v", err)
	}
	select {
	case <-changed:
		t.Fatal("a refused install sent setup-changed")
	default:
	}
}

// contract: setup.host.reads-the-login-shell-environment-without-the-launcher
func TestTheSidecarEnvironmentIsTheLoginShellEnvironmentWithoutTheVariablesOfTheLauncher(t *testing.T) {
	h := newSetupHome(t, "")
	// The variable stands for a variable of the process that started the application, such as a session variable of an agent.
	t.Setenv("SOKSAK_FIXTURE_LEAK", "launcher")
	setups, changed := h.setups(t)
	setups.Start()
	<-changed
	environment, err := setups.SidecarEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	if value, present := environment["SOKSAK_FIXTURE_LEAK"]; present {
		t.Fatalf("a variable of the launcher reached the login shell: %q in %v", value, environment)
	}
	if environment["HOME"] != h.home || !strings.HasPrefix(environment["PATH"], filepath.Dir(h.sok)) {
		t.Fatalf("HOME and PATH of the start files: %v", environment)
	}
	for _, name := range []string{"PWD", "SHLVL", "_"} {
		if _, present := environment[name]; present {
			t.Fatalf("%s of the shell process: %v", name, environment)
		}
	}
}
