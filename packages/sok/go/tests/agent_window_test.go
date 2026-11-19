package tests

// Checks the window of an agent (docs/spec/cli.md#the-window-of-an-agent): SOKSAK_CONFIG_DIR names the configuration directory,
// SOKSAK_SURFACE selects the window of its surface, sok context prints both, and a sok whose directory belongs to an application
// of another sok hands the command to that sok.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/src"
	"github.com/soksak-app/core/packages/sok/go/tests/support"
)

func runMain(args ...string) (int, string, string) {
	var stdout, stderr strings.Builder
	code := sok.Main(args, &stdout, &stderr, sok.Options{Identifier: "com.soksak.test", PathsDir: pathsDir, CoreVersion: "0.0.2"})
	return code, stdout.String(), stderr.String()
}

// eventFiles are the event files of the run in the logs folder of the configuration directory.
func eventFiles(t *testing.T, config string) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(config, "logs", "sok-*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// storedEvents are the events of the name in every event file of the configuration directory, as their fields.
func storedEvents(t *testing.T, config, name string) []map[string]any {
	t.Helper()
	events := []map[string]any{}
	for _, file := range eventFiles(t, config) {
		handle, err := os.Open(file)
		if err != nil {
			t.Fatal(err)
		}
		scanner := bufio.NewScanner(handle)
		for scanner.Scan() {
			var event struct {
				Event  string         `json:"event"`
				Fields map[string]any `json:"fields"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
				t.Fatalf("%s: %v", file, err)
			}
			if event.Event == name {
				events = append(events, event.Fields)
			}
		}
		handle.Close()
	}
	return events
}

// contract: cli.config-dir.environment-names-the-directory
func TestTheConfigurationDirectoryComesFromTheEnvironment(t *testing.T) {
	fromEnvironment := t.TempDir()
	t.Setenv(configDirVariable, fromEnvironment)
	code, _, stderr := runMain("windows")
	if code != 1 || stderr != "sok: "+filepath.Join(fromEnvironment, "endpoint.json")+" does not exist; the application is not running\n" || len(eventFiles(t, fromEnvironment)) != 1 {
		t.Fatalf("code %d stderr %q files %v", code, stderr, eventFiles(t, fromEnvironment))
	}
	given := t.TempDir()
	code, _, stderr = runMain("windows", "--config-dir", given)
	if code != 1 || stderr != "sok: "+filepath.Join(given, "endpoint.json")+" does not exist; the application is not running\n" || len(eventFiles(t, given)) != 1 || len(eventFiles(t, fromEnvironment)) != 1 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	// An empty value names no directory.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv(configDirVariable, "")
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	if code, _, stderr := run("windows"); code != 1 || stderr != "sok: "+filepath.Join(base, "com.soksak.test", "endpoint.json")+" does not exist; the application is not running\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

// contract: cli.window.surface-variable-selects-its-window
func TestTheSurfaceVariableSelectsItsWindow(t *testing.T) {
	player := playCase(t, "sok-surface-window")
	t.Setenv(surfaceVariable, "terminal-1")
	for _, args := range [][]string{{"status", "core.screen"}, {"status", "core.screen"}, {"status", "core.screen", "--window", "project-a"}} {
		if code, stdout, stderr := run(append(args, "--config-dir", player.configDir)...); code != 0 || stdout != "\"ok\"\n" {
			t.Fatalf("%v: code %d stdout %q stderr %q", args, code, stdout, stderr)
		}
	}
	t.Setenv(surfaceVariable, "")
	if code, stdout, stderr := run("status", "core.screen", "--config-dir", player.configDir); code != 0 || stdout != "\"ok\"\n" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	if methods := player.methods(); fmt.Sprint(methods) != "[surface.window status.get surface.window status.get status.get windows.list status.get]" {
		t.Fatalf("methods %v", methods)
	}
}

// contract: cli.window.surface-in-no-window-fails
func TestASurfaceInNoWindowFails(t *testing.T) {
	player := playCase(t, "sok-surface-in-no-window")
	t.Setenv(surfaceVariable, "terminal-9")
	code, stdout, stderr := run("status", "core.screen", "--config-dir", player.configDir)
	if code != 1 || stdout != "" || stderr != "sok: SOKSAK_SURFACE names surface terminal-9, which is in no window of the application\n" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.context.prints-the-agent-context
func TestContextPrintsTheAgentContext(t *testing.T) {
	config := t.TempDir()
	code, stdout, stderr := run("context", "--config-dir", config)
	want := fmt.Sprintf("{\n  \"configDirectory\": %q,\n  \"surface\": null,\n  \"window\": null\n}\n", config)
	if code != 0 || stdout != want {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	player := playCase(t, "sok-context")
	t.Setenv(surfaceVariable, "terminal-1")
	t.Setenv(configDirVariable, player.configDir)
	code, stdout, stderr = run("context")
	want = fmt.Sprintf("{\n  \"configDirectory\": %q,\n  \"surface\": \"terminal-1\",\n  \"window\": \"project-a\"\n}\n", player.configDir)
	if code != 0 || stdout != want {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.config-dir.hands-the-command-to-the-application-sok
func TestTheCommandIsHandedToTheSokOfTheApplication(t *testing.T) {
	program := builtSok(t)
	running := copyExecutable(t, program, filepath.Join(t.TempDir(), "sok"))
	application := copyExecutable(t, program, filepath.Join(t.TempDir(), "Other.app", "Contents", "MacOS", "sok"))
	config := t.TempDir()
	support.StoreEveryLevel(t, config)
	endpoint := fmt.Sprintf(`{"transport": "unix", "address": "/nonexistent/e.sock", "pid": 1, "executable": %q}`, filepath.Join(filepath.Dir(application), "host"))
	writeText(t, filepath.Join(config, "endpoint.json"), endpoint)
	home := t.TempDir()
	env := []string{"HOME=" + home, "PATH=/usr/bin:/bin", configDirVariable + "=" + config}
	code, stdout, stderr := runProgram(t, running, env, "context")
	want := fmt.Sprintf("{\n  \"configDirectory\": %q,\n  \"surface\": null,\n  \"window\": null\n}\n", config)
	if code != 0 || stdout != want || stderr != "" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	execs := storedEvents(t, config, "sok.exec")
	if len(execs) != 1 || execs[0]["from"] != running || execs[0]["to"] != application || execs[0]["config"] != config {
		t.Fatalf("sok.exec events %v", execs)
	}
	commands := storedEvents(t, config, "sok.command")
	if len(commands) != 2 || commands[0]["status"] != float64(0) || commands[0]["args"] != "context" || commands[1]["args"] != "context" {
		t.Fatalf("sok.command events %v", commands)
	}
	// --config-dir takes precedence, so no replacement happens.
	code, _, _ = runProgram(t, running, env, "context", "--config-dir", config)
	if code != 0 || len(storedEvents(t, config, "sok.exec")) != 1 {
		t.Fatalf("code %d sok.exec %v", code, storedEvents(t, config, "sok.exec"))
	}
	// An endpoint.json that does not parse fails the run with its position.
	writeText(t, filepath.Join(config, "endpoint.json"), "{\n  \"executable\": nope}")
	code, stdout, stderr = runProgram(t, running, env, "context")
	if code != 1 || stdout != "" || stderr != "sok: "+filepath.Join(config, "endpoint.json")+" is not valid JSON at line 2 column 18\n" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	// Without endpoint.json the running sok runs the command, and a command that needs the application fails.
	if err := os.Remove(filepath.Join(config, "endpoint.json")); err != nil {
		t.Fatal(err)
	}
	code, _, stderr = runProgram(t, running, env, "windows")
	if code != 1 || stderr != "sok: "+filepath.Join(config, "endpoint.json")+" does not exist; the application is not running\n" || len(storedEvents(t, config, "sok.exec")) != 1 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

// windowDescribeSteps are the window_describe calls of the case mcp-window-describe: the arguments with the result or the error.
func windowDescribeSteps(t *testing.T) []struct {
	Arguments map[string]any  `json:"arguments"`
	Result    json.RawMessage `json:"result"`
	Error     string          `json:"error"`
} {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(caseDirectory(t), "mcp-window-describe.json"))
	if err != nil {
		t.Fatal(err)
	}
	var kase struct {
		MCP struct {
			Steps []struct {
				Arguments map[string]any  `json:"arguments"`
				Result    json.RawMessage `json:"result"`
				Error     string          `json:"error"`
			} `json:"steps"`
		} `json:"mcp"`
	}
	if err := json.Unmarshal(data, &kase); err != nil {
		t.Fatal(err)
	}
	return kase.MCP.Steps
}

// describeFlags are the flags of sok describe for the arguments of window_describe, in the order of their names.
func describeFlags(t *testing.T, arguments map[string]any) []string {
	t.Helper()
	var flags []string
	for _, name := range []string{"after", "full", "limit", "surface", "window"} {
		switch value := arguments[name].(type) {
		case nil:
		case bool:
			if value {
				flags = append(flags, "--"+name)
			}
		case float64:
			flags = append(flags, "--"+name, fmt.Sprint(value))
		case string:
			flags = append(flags, "--"+name, value)
		default:
			t.Fatalf("argument %s is %v", name, value)
		}
		delete(arguments, name)
	}
	if len(arguments) != 0 {
		t.Fatalf("window_describe arguments without a flag: %v", arguments)
	}
	return flags
}

// contract: cli.describe.lists-every-entry, cli.describe.compact-form-and-pages
func TestDescribePrintsThePagesOfWindowDescribe(t *testing.T) {
	player := playCase(t, "sok-describe")
	t.Setenv(surfaceVariable, "terminal-1")
	for n, step := range windowDescribeSteps(t) {
		args := append([]string{"describe", "--config-dir", player.configDir}, describeFlags(t, step.Arguments)...)
		code, stdout, stderr := run(args...)
		switch {
		case step.Error == "limit must be an integer from 1 to 500":
			if code != 2 || stdout != "" || !strings.HasPrefix(stderr, "sok: --limit must be an integer from 1 to 500\n") {
				t.Fatalf("step %d %v: code %d stdout %q stderr %q", n, args, code, stdout, stderr)
			}
		case step.Error != "":
			if code != 1 || stdout != "" || stderr != "sok: "+step.Error+"\n" {
				t.Fatalf("step %d %v: code %d stdout %q stderr %q", n, args, code, stdout, stderr)
			}
		default:
			var printed, want any
			if err := json.Unmarshal([]byte(stdout), &printed); err != nil || code != 0 || !strings.HasSuffix(stdout, "}\n") {
				t.Fatalf("step %d %v: code %d stdout %q stderr %q", n, args, code, stdout, stderr)
			}
			if err := json.Unmarshal(step.Result, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(printed, want) {
				t.Fatalf("step %d %v printed\n%s\nwant\n%s", n, args, stdout, step.Result)
			}
		}
	}
	// The pages of --limit 2 hold each row of the description once, the first page alone the window, and total is their number.
	var keys []string
	after := ""
	for page := 0; ; page++ {
		args := []string{"describe", "--config-dir", player.configDir, "--limit", "2"}
		if after != "" {
			args = append(args, "--after", after)
		}
		code, stdout, stderr := run(args...)
		var printed map[string]any
		if err := json.Unmarshal([]byte(stdout), &printed); err != nil || code != 0 {
			t.Fatalf("page %d: code %d stdout %q stderr %q", page, code, stdout, stderr)
		}
		_, hasWindow := printed["window"]
		_, hasLayout := printed["layout"]
		_, hasPlugins := printed["plugins"]
		_, hasAgent := printed["agent"]
		if (page == 0) != (hasWindow && hasLayout && hasPlugins && hasAgent) || printed["total"] != float64(7) {
			t.Fatalf("page %d: %s", page, stdout)
		}
		rows, _ := printed["rows"].([]any)
		for _, row := range rows {
			keys = append(keys, row.(map[string]any)["key"].(string))
		}
		next, _ := printed["next"].(string)
		if next == "" {
			break
		}
		after = next
	}
	want := "[host status host.window host command host.window.reload core status core.screen core command core.layout.open core element core.tab terminal-1 command terminal.input unregistered command browser.reload]"
	if fmt.Sprint(keys) != want {
		t.Fatalf("rows %v\nwant %s", keys, want)
	}
	if methods := player.methods(); len(methods) != 20 {
		t.Fatalf("methods %v", methods)
	}
}

// contract: cli.exposures.query-filters-entries
func TestAQueryKeepsTheEntriesThatHoldEachWord(t *testing.T) {
	player := playCase(t, "sok-exposures-query")
	names := func(stdout, member string) string {
		var printed map[string][]map[string]any
		if member == "" {
			var list []map[string]any
			if err := json.Unmarshal([]byte(stdout), &list); err != nil {
				t.Fatalf("stdout %q: %v", stdout, err)
			}
			printed = map[string][]map[string]any{"": list}
		} else if err := json.Unmarshal([]byte(stdout), &printed); err != nil {
			t.Fatalf("stdout %q: %v", stdout, err)
		}
		var found []string
		for kind, entries := range printed {
			if member != "" && kind != member {
				t.Fatalf("%s holds the list %s", stdout, kind)
			}
			for _, entry := range entries {
				if _, whole := entry["params"]; member != "status" && member != "element" && !whole {
					t.Fatalf("the entry %v is not the whole declaration", entry)
				}
				found = append(found, entry["name"].(string))
			}
		}
		return fmt.Sprint(found)
	}
	for _, c := range []struct {
		args   []string
		member string
		want   string
	}{
		{[]string{"exposures", "--kind", "command", "--query", "PROJECT open"}, "commands", "[core.project.open]"},
		{[]string{"exposures", "--kind", "status", "--query", " \t "}, "status", "[core.screen host.window]"},
		{[]string{"commands", "--query", "window\n again"}, "", "[host.window.reload]"},
		{[]string{"exposures", "--kind", "command", "--query", "änderung"}, "commands", "[]"},
		{[]string{"exposures", "--kind", "command", "--query", "Änderung DATEI"}, "commands", "[editor.Änderung]"},
		{[]string{"exposures", "--kind", "element", "--query", "SCREEN tab"}, "element", "[core.tab]"},
	} {
		code, stdout, stderr := run(append(c.args, "--config-dir", player.configDir)...)
		if code != 0 || stderr != "" {
			t.Fatalf("%q: code %d stdout %q stderr %q", c.args, code, stdout, stderr)
		}
		if found := names(stdout, c.member); found != c.want {
			t.Fatalf("%q printed %s, want %s", c.args, found, c.want)
		}
	}
	if code, stdout, stderr := run("exposures", "--kind", "screen", "--config-dir", player.configDir); code != 2 || stdout != "" || !strings.HasPrefix(stderr, "sok: --kind must be status, command or element\n") {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.describe.refuses-a-lone-surrogate
func TestDescribeRefusesALoneSurrogateEscape(t *testing.T) {
	snapshot := `{"window":{"window":"main","title":"soksak","project":null},"layout":{"space":"space-1","focused":null,"root":null},` +
		`"plugins":[],"groups":[{"owner":"core","status":[{"name":"core.screen","description":"Current screen.","schema":{},` +
		`"value":"a\ud800b"}],"commands":[],"element":[]}],"unregistered":[]}`
	player := playCase(t, "sok-describe-lone-surrogate", withRawJSON("snapshot", snapshot))
	code, stdout, stderr := run("describe", "--config-dir", player.configDir)
	if code != 1 || stdout != "" || stderr != "sok: status core.screen of group core: the value holds a lone surrogate escape\n" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.context.prints-the-agent-context
func TestContextTakesOnlyTheConfigurationDirectory(t *testing.T) {
	config := t.TempDir()
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"context", "main"}, "sok: context takes no argument: main\n"},
		{[]string{"context", "--kind", "status"}, "sok: context takes only --config-dir\n"},
		{[]string{"context", "--window", "main"}, "sok: context takes only --config-dir\n"},
		{[]string{"context", "--full"}, "sok: context takes only --config-dir\n"},
	} {
		code, stdout, stderr := run(append(c.args, "--config-dir", config)...)
		if code != 2 || stdout != "" || !strings.HasPrefix(stderr, c.want) {
			t.Fatalf("%v: code %d stdout %q stderr %q", c.args, code, stdout, stderr)
		}
	}
}

// contract: cli.describe.summary-and-full
func TestDescribeSummaryHoldsSummaryStatusesAndFullHoldsEveryStatus(t *testing.T) {
	player := playCase(t, "sok-describe-summary-and-full")
	_, summary, stderr := run("describe", "--config-dir", player.configDir)
	if !strings.Contains(summary, `"probe.busy"`) {
		t.Fatalf("summary lacks the tab statuses: stderr %q stdout %s", stderr, summary)
	}
	if strings.Contains(summary, `"probe.detail"`) {
		t.Fatalf("summary holds a status that is not a summary: %s", summary)
	}
	_, full, stderr := run("describe", "--full", "--config-dir", player.configDir)
	if !strings.Contains(full, `"probe.detail"`) || !strings.Contains(full, `"probe.busy"`) {
		t.Fatalf("full lacks the statuses of the tab: stderr %q stdout %s", stderr, full)
	}
}
