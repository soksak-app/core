package tests

// Checks the contract of sok (docs/spec/cli.md) against the endpoint contract cases of docs/spec/cases/endpoint. Each test that needs
// an endpoint plays the case of its name with the case player (case_player_test.go), which writes endpoint.json, answers only the
// frames that the case contains and reports every difference when the test ends.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/src"
	_ "github.com/soksak-app/core/packages/sok/go/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/sok/go/src/platform/linux"
)

// pathsDir is the paths.d slot that the path entry checks change.
var pathsDir = "/nonexistent/paths.d"

func run(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := sok.Run(args, &stdout, &stderr, sok.Options{Identifier: "com.soksak.test", PathsDir: pathsDir, CoreVersion: "0.0.2"})
	return code, stdout.String(), stderr.String()
}

// contract: cli.usage.unknown-command-exits-2
func TestUnknownCommandExitsWithUsage(t *testing.T) {
	code, stdout, stderr := run("nothing", "--config-dir", t.TempDir())
	if code != 2 || stdout != "" || !strings.HasPrefix(stderr, "sok: unknown command: nothing\nusage: sok <command>") {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// unwritable is a standard error that always rejects writes.
type unwritable struct{}

func (unwritable) Write([]byte) (int, error) { return 0, errors.New("standard error is closed") }

// contract: cli.error.unwritable-stderr-exits-3
func TestAnErrorThatCannotBeWrittenExitsWithStatus3(t *testing.T) {
	var stdout bytes.Buffer
	code := sok.Run([]string{"nothing", "--config-dir", t.TempDir()}, &stdout, unwritable{}, sok.Options{Identifier: "com.soksak.test", PathsDir: pathsDir, CoreVersion: "0.0.2"})
	if code != 3 {
		t.Fatalf("code %d", code)
	}
}

// contract: cli.endpoint.missing-file-reports-not-running
func TestMissingEndpointReportsTheApplicationIsNotRunning(t *testing.T) {
	dir := t.TempDir()
	code, _, stderr := run("windows", "--config-dir", dir)
	want := fmt.Sprintf("sok: %s does not exist; the application is not running\n", filepath.Join(dir, "endpoint.json"))
	if code != 1 || stderr != want {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

// contract: cli.output.indents-result-keeping-key-order
func TestResultIsIndentedInTheEndpointKeyOrder(t *testing.T) {
	player := playCase(t, "sok-status-value")
	code, stdout, stderr := run("status", "core.screen", "--window", "main", "--config-dir", player.configDir)
	want := "{\n  \"zeta\": 1,\n  \"alpha\": [],\n  \"mid\": {\n    \"b\": true,\n    \"a\": null\n  },\n  \"list\": [\n    1,\n    \"x\"\n  ],\n  \"empty\": {}\n}\n"
	if code != 0 || stdout != want {
		t.Fatalf("code %d stderr %q stdout %q", code, stderr, stdout)
	}
}

// contract: cli.window.single-window-is-default, cli.requests.carry-command-parameters
func TestTheOnlyWindowIsUsedAndParametersAreSent(t *testing.T) {
	player := playCase(t, "sok-parameters")
	cases := []struct {
		args   []string
		method string
		params string
	}{
		{[]string{"status", "core.screen", "--surface", "tab-1"}, "status.get", `{"name":"core.screen","surface":"tab-1","window":"main"}`},
		{[]string{"exposures"}, "exposure.list", `{"window":"main"}`},
		{[]string{"element", "rect", "core.card", "--index", "2"}, "element.rect", `{"index":2,"name":"core.card","window":"main"}`},
		{[]string{"element", "input", "fixture.input", "--value", "ls"}, "element.act", `{"action":"input","name":"fixture.input","value":"ls","window":"main"}`},
		{[]string{"element", "dispatch", "x.y", "--event", `{"type":"keydown","key":"a"}`}, "element.act", `{"action":"dispatch","event":{"key":"a","type":"keydown"},"name":"x.y","window":"main"}`},
		{[]string{"input", "pointer", "--x", "1.5", "--y", "2", "--phase", "move", "--activate"}, "input.pointer", `{"activate":true,"phase":"move","window":"main","x":1.5,"y":2}`},
		{[]string{"input", "pointer", "--x", "1", "--y", "2", "--phase", "down", "--clicks", "2"}, "input.pointer", `{"clicks":2,"phase":"down","window":"main","x":1,"y":2}`},
		{[]string{"input", "pointer", "--pointer", "second", "--x", "3", "--y", "4", "--phase", "drag"}, "input.pointer", `{"phase":"drag","pointer":"second","window":"main","x":3,"y":4}`},
		{[]string{"input", "key", "--key", "a", "--phase", "down", "--modifiers", "shift,,command"}, "input.key", `{"key":"a","modifiers":["shift","command"],"phase":"down","window":"main"}`},
		{[]string{"input", "text", "--phase", "mark", "--text", "한글", "--selection", "0,1", "--replacement", "2,3"}, "input.text", `{"phase":"mark","replacement":{"length":3,"start":2},"selection":{"length":1,"start":0},"text":"한글","window":"main"}`},
		{[]string{"input", "text", "--phase", "unmark"}, "input.text", `{"phase":"unmark","window":"main"}`},
	}
	for _, c := range cases {
		code, stdout, stderr := run(append(c.args, "--config-dir", player.configDir)...)
		if code != 0 || stdout != "null\n" {
			t.Fatalf("%v: code %d stdout %q stderr %q", c.args, code, stdout, stderr)
		}
		methods := player.methods()
		got, _ := json.Marshal(player.last())
		if methods[len(methods)-1] != c.method || string(got) != c.params {
			t.Fatalf("%v: sent %s %s, want %s %s", c.args, methods[len(methods)-1], got, c.method, c.params)
		}
	}
}

// contract: cli.window.several-windows-need-selection, cli.window.project-selects-by-canonical-folder
func TestSeveralWindowsNeedSelection(t *testing.T) {
	project := t.TempDir()
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(project, alias); err != nil {
		t.Fatal(err)
	}
	player := playCase(t, "sok-several-windows", withText("project", project))
	code, _, stderr := run("status", "core.screen", "--config-dir", player.configDir)
	if code != 2 || !strings.HasPrefix(stderr, "sok: the application has 2 windows (main, project-a); select one with --window or --project\n") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	code, stdout, stderr := run("status", "core.screen", "--project", alias, "--config-dir", player.configDir)
	if code != 0 || stdout != "\"ok\"\n" || player.last()["window"] != "project-a" {
		t.Fatalf("code %d stdout %q stderr %q params %v", code, stdout, stderr, player.last())
	}
	code, _, stderr = run("status", "core.screen", "--window", "main", "--project", project, "--config-dir", player.configDir)
	if code != 2 || !strings.HasPrefix(stderr, "sok: --window and --project select the window in two ways; give one\n") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

// contract: cli.error.reports-endpoint-code
func TestEndpointErrorsCarryTheirCode(t *testing.T) {
	player := playCase(t, "sok-error-code")
	code, stdout, stderr := run("status", "core.screen", "--window", "main", "--config-dir", player.configDir)
	if code != 1 || stdout != "" || stderr != "sok: send request 1: the main page is not ready (1003)\n" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.status.watch-prints-value-and-changes
func TestWatchPrintsTheValueAndEachChange(t *testing.T) {
	player := playCase(t, "sok-watch-changes")
	code, stdout, stderr := run("status", "core.screen", "--window", "main", "--watch", "--config-dir", player.configDir)
	if stdout != "{\"screen\":\"library\"}\n{\"screen\":\"workspace\"}\n" || code != 1 || stderr != "sok: endpoint connection closed\n" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	if got := strings.Join(player.methods(), ","); got != "status.watch,status.get" {
		t.Fatalf("methods %s", got)
	}
}

// A status.ended of the watched status ends the watch with exit status 1 and the error that names the status and the reason;
// a status.ended of another status does not.
// contract: endpoint.status.ended-ends-a-watch
func TestAWatchEndsWhenItsProducerEnds(t *testing.T) {
	player := playCase(t, "sok-watch-ends")
	code, stdout, stderr := run("status", "fixture.value", "--window", "main", "--surface", "tab", "--watch", "--config-dir", player.configDir)
	if code != 1 || stdout != "1\n" || stderr != "sok: status fixture.value ended: surface-closed\n" {
		t.Fatalf("code %d stdout %q stderr %q, want 1, the value and the end of the watch", code, stdout, stderr)
	}
}

// A gesture sends down at the first point, a drag to each later point and up at the last point, on one connection, and prints
// nothing.
// contract: cli.input.gesture-sends-one-press-on-one-connection
func TestAGestureSendsItsStepsOnOneConnection(t *testing.T) {
	player := playCase(t, "sok-gesture")
	code, stdout, stderr := run("input", "gesture", "--window", "main", "--pointer", "second", "--clicks", "2", "--points", "10,20;30,40;50,60", "--config-dir", player.configDir)
	if code != 0 || stdout != "" || stderr != "" {
		t.Fatalf("code %d stdout %q stderr %q, want 0 and no output", code, stdout, stderr)
	}
	if n := player.connectionCount(); n != 1 {
		t.Fatalf("the gesture used %d connections, want 1", n)
	}
	want := []string{"down 10 20 2", "drag 30 40 <nil>", "drag 50 60 <nil>", "up 50 60 2"}
	frames := player.frames()
	if len(frames) != len(want) {
		t.Fatalf("requests %v, want %v", frames, want)
	}
	for n, request := range frames {
		params, _ := request["params"].(map[string]any)
		got := fmt.Sprintf("%v %v %v %v", params["phase"], params["x"], params["y"], params["clicks"])
		if request["method"] != "input.pointer" || got != want[n] || params["pointer"] != "second" || params["window"] != "main" {
			t.Fatalf("step %d is %v %v, want input.pointer %s of pointer second in main", n+1, request["method"], params, want[n])
		}
	}
}

// A gesture step that fails ends the command with the error of the step and its number.
// contract: cli.input.gesture-step-failure-ends-the-command
func TestAGestureStepThatFailsEndsTheCommand(t *testing.T) {
	player := playCase(t, "sok-gesture-failure")
	code, _, stderr := run("input", "gesture", "--window", "main", "--points", "1,2;3,4", "--config-dir", player.configDir)
	if code != 1 || stderr != "sok: gesture step 2: held (1007)\n" {
		t.Fatalf("code %d stderr %q, want 1 and the error of step 2", code, stderr)
	}
	if got := strings.Join(player.methods(), ","); got != "input.pointer,input.pointer" {
		t.Fatalf("methods %s, want the down and the failed drag", got)
	}
}

// contract: cli.config-dir.default-uses-application-identifier
func TestTheDefaultConfigurationDirectoryIsTheApplications(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	code, _, stderr := run("windows")
	want := fmt.Sprintf("sok: %s does not exist; the application is not running\n", filepath.Join(base, "com.soksak.test", "endpoint.json"))
	if code != 1 || stderr != want || !strings.HasPrefix(base, home) {
		t.Fatalf("code %d stderr %q want %q", code, stderr, want)
	}
}

// contract: cli.command.host-command-without-page
func TestAHostCommandIsCheckedAgainstTheHostEntriesWithoutThePage(t *testing.T) {
	player := playCase(t, "sok-host-command")
	code, _, stderr := run("host.quit", "--config-dir", player.configDir)
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	sent, _ := json.Marshal(player.last())
	if string(sent) != `{"name":"host.quit","params":{},"window":"main"}` {
		t.Fatalf("sent %s", sent)
	}
}

// contract: cli.command.flags-from-schema
func TestDeclaredCommandFlagsFollowTheSchema(t *testing.T) {
	player := playCase(t, "sok-declared-flags")
	code, stdout, stderr := run("fixture.do", "--text=--x", "--count=1.5", "--whole", "3", "--flag", "--choice", "two",
		"--maybe", "null", "--object", `{"a":1}`, "--list", "[1]", "--surface", "tab-1", "--config-dir", player.configDir)
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	sent, _ := json.Marshal(player.last())
	want := `{"name":"fixture.do","params":{"choice":"two","count":1.5,"flag":true,"list":[1],"maybe":null,"object":{"a":1},"text":"--x","whole":3},"surface":"tab-1","window":"main"}`
	if string(sent) != want || !strings.HasPrefix(stdout, "{\n  \"name\": \"fixture.do\"") {
		t.Fatalf("sent %s stdout %q", sent, stdout)
	}
	code, _, stderr = run("fixture.do", "--params", `{"text":"x"}`, "--config-dir", player.configDir)
	sent, _ = json.Marshal(player.last())
	if code != 0 || string(sent) != `{"name":"fixture.do","params":{"text":"x"},"window":"main"}` {
		t.Fatalf("code %d stderr %q sent %s", code, stderr, sent)
	}
}

// contract: cli.command.rejects-undeclared-or-invalid-values
func TestDeclaredCommandRejectsBadFlagsBeforeSending(t *testing.T) {
	player := playCase(t, "sok-declared-rejects")
	cases := []struct {
		want string
		args []string
	}{
		{"sok: --nope is not a parameter of fixture.do; its parameters are choice, count, flag, list, maybe, object, text, whole\n", []string{"fixture.do", "--nope", "1"}},
		{"sok: --choice must be one of one, two\n", []string{"fixture.do", "--choice", "three"}},
		{"sok: --whole must be integer\n", []string{"fixture.do", "--whole", "1.5"}},
		{"sok: --count must be number\n", []string{"fixture.do", "--count", "x"}},
		{"sok: --object must be object\n", []string{"fixture.do", "--object", "[1]"}},
		{"sok: unexpected argument yes\n", []string{"fixture.do", "--flag", "yes"}},
		{"sok: --text needs a value\n", []string{"fixture.do", "--text"}},
		{"sok: --params gives the whole parameter object and cannot be combined with parameter flags\n", []string{"fixture.do", "--params", "{}", "--text", "x"}},
		{"sok: fixture.gone is not a declared command of window main; sok commands lists them\n", []string{"fixture.gone"}},
	}
	for _, c := range cases {
		code, stdout, stderr := run(append(c.args, "--config-dir", player.configDir)...)
		if code != 2 || stdout != "" || !strings.HasPrefix(stderr, c.want) {
			t.Fatalf("%v: code %d stdout %q stderr %q", c.args, code, stdout, stderr)
		}
	}
	for _, method := range player.methods() {
		if method == "command.run" {
			t.Fatalf("a rejected command was sent: %v", player.methods())
		}
	}
}

// contract: cli.commands.lists-declared-commands
func TestCommandsListsTheDeclaredCommandsInOrder(t *testing.T) {
	player := playCase(t, "sok-commands")
	code, stdout, stderr := run("commands", "--config-dir", player.configDir)
	var commands []map[string]any
	if err := json.Unmarshal([]byte(stdout), &commands); err != nil || code != 0 {
		t.Fatalf("code %d stderr %q stdout %q", code, stderr, stdout)
	}
	if len(commands) != 2 || commands[0]["name"] != "fixture.do" || commands[1]["name"] != "fixture.none" {
		t.Fatalf("commands %v", commands)
	}
}

// contract: cli.path.writes-and-removes-the-entry
func TestPathInstallWritesTheExecutableDirectoryAndRemoveDeletesIt(t *testing.T) {
	pathsDir = t.TempDir()
	t.Cleanup(func() { pathsDir = "/nonexistent/paths.d" })
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(pathsDir, "com.soksak.test")
	for range 2 {
		code, stdout, stderr := run("path", "install")
		want := fmt.Sprintf("{\n  \"directory\": %q,\n  \"path\": %q\n}\n", filepath.Dir(executable), entry)
		if code != 0 || stdout != want {
			t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
		}
		if data, err := os.ReadFile(entry); err != nil || string(data) != filepath.Dir(executable)+"\n" {
			t.Fatalf("entry %q %v", data, err)
		}
	}
	for range 2 {
		if code, stdout, stderr := run("path", "remove"); code != 0 || stdout != "null\n" {
			t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
		}
	}
	if _, err := os.Stat(entry); !os.IsNotExist(err) {
		t.Fatalf("the entry remains: %v", err)
	}
	pathsDir = filepath.Join(t.TempDir(), "missing")
	code, _, stderr := run("path", "install")
	if code != 1 || !strings.HasPrefix(stderr, "sok: cannot write "+filepath.Join(pathsDir, "com.soksak.test")+": ") || !strings.HasSuffix(stderr, "; run sudo sok path install\n") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

// contract: cli.path.fails-without-a-path-entry-folder
func TestPathEntriesFailWhereTheOperatingSystemHasNoFolder(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := sok.Run([]string{"path", "install"}, &stdout, &stderr, sok.Options{Identifier: "com.soksak.test", PathsError: errors.New("path entries are not implemented on linux"), CoreVersion: "0.0.2"})
	if code != 1 || stdout.String() != "" || stderr.String() != "sok: path entries are not implemented on linux\n" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout.String(), stderr.String())
	}
}

// watchChild names the configuration directory of the watch that the child process of
// TestAnInterruptEndsAWatchThatWaitsInAWrite runs.
const watchChild = "SOK_TEST_WATCH_CHILD"

// SIGINT ends a watch whose write to its standard output waits, because nothing reads it: the routine that receives the
// signal closes the connection and ends the process with status 0 (docs/spec/cli.md).
// contract: cli.status.signal-ends-a-watch-that-waits-in-a-write
func TestAnInterruptEndsAWatchThatWaitsInAWrite(t *testing.T) {
	if config := os.Getenv(watchChild); config != "" {
		os.Exit(sok.Main([]string{"status", "fixture.value", "--window", "main", "--watch", "--config-dir", config}, os.Stdout, os.Stderr,
			sok.Options{Identifier: "com.soksak.test", PathsDir: pathsDir, CoreVersion: "0.0.2"}))
	}
	// The value is larger than the buffer of a pipe, so its write waits while nothing reads the pipe.
	player := playCase(t, "sok-interrupt-watch", withText("value", strings.Repeat("x", 1<<20)))
	unread, stdout, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer unread.Close()
	var stderr strings.Builder
	cmd := exec.Command(os.Args[0], "-test.run=^TestAnInterruptEndsAWatchThatWaitsInAWrite$")
	cmd.Env = append(os.Environ(), watchChild+"="+player.configDir)
	cmd.Stdout, cmd.Stderr = stdout, &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stdout.Close()
	// The first byte of the value is the start of its write, which cannot end while the rest of the pipe is not read. A watch
	// that never writes leaves the test to the limit of its runner, which reports the stall.
	first := make([]byte, 1)
	if _, err := io.ReadFull(unread, first); err != nil || first[0] != '"' {
		cmd.Process.Signal(syscall.SIGKILL)
		cmd.Wait()
		t.Fatalf("the watch wrote %q (%v), want the start of the value", first, err)
	}
	if err := cmd.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	// The pipe stays unread, so the write still waits while the watch ends. A watch that does not end leaves the test to the
	// limit of its runner.
	code := 0
	if err := cmd.Wait(); err != nil {
		exit, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatal(err)
		}
		code = exit.ExitCode()
	}
	if code != 0 || stderr.String() != "" {
		t.Fatalf("exit status %d stderr %q, want 0 and no error after SIGINT", code, stderr.String())
	}
}
