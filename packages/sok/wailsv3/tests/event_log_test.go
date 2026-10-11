package tests

// Checks the event file of the tool (docs/spec/cli.md#event-log, docs/spec/logging.md): every run writes
// logs/sok-<boot>.jsonl in the configuration directory it targets, with the command and its result, and a panic with its
// stack.

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

type loggedEvent struct {
	TsMicros int64          `json:"ts_us"`
	MonoNs   uint64         `json:"mono_ns"`
	Seq      uint64         `json:"seq"`
	Level    string         `json:"level"`
	Class    string         `json:"class"`
	Layer    string         `json:"layer"`
	Event    string         `json:"event"`
	Fields   map[string]any `json:"fields"`
	// Undeclared is set on a line whose event the catalog does not declare.
	Undeclared bool `json:"undeclared"`
}

// eventsOf reads the events that a run left in the logs folder of config: the main file and, when the run stored a debug event, the
// debug file, in the order of seq.
func eventsOf(t *testing.T, config string) []loggedEvent {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(config, "logs", "sok-*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var main []string
	for _, file := range files {
		if !strings.HasSuffix(file, ".debug.jsonl") {
			main = append(main, file)
		}
	}
	if len(main) != 1 || len(files) > 2 {
		t.Fatalf("logs/ of %s holds the event files %v of the tool, want one main file and at most one debug file", config, files)
	}
	var events []loggedEvent
	for _, file := range files {
		text, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(strings.TrimSuffix(string(text), "\n"), "\n") {
			var event loggedEvent
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				t.Fatalf("%s: %q is not an event: %v", file, line, err)
			}
			events = append(events, event)
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].Seq < events[j].Seq })
	return events
}

func named(events []loggedEvent, name string) []loggedEvent {
	var found []loggedEvent
	for _, event := range events {
		if event.Event == name {
			found = append(found, event)
		}
	}
	return found
}

func loggedRun(config string, command sok.Command, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := sok.Logged(append(args, "--config-dir", config), &stdout, &stderr, sok.Options{Identifier: "com.soksak.test", PathsDir: pathsDir, CoreVersion: "0.0.2"}, command)
	return code, stdout.String(), stderr.String()
}

// contract: cli.log.records-each-command-with-its-result
func TestEachCommandIsRecordedWithItsResult(t *testing.T) {
	config := t.TempDir()
	code, _, stderr := loggedRun(config, sok.Run, "nothing")
	if code != 2 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	events := eventsOf(t, config)
	if events[0].Event != "log.open" || events[0].Layer != "sok" || events[0].Seq != 1 {
		t.Fatalf("the first line is %+v, want log.open of the layer sok with seq 1", events[0])
	}
	for _, event := range events {
		if event.Layer != "sok" || event.MonoNs == 0 || event.TsMicros == 0 {
			t.Fatalf("%+v lacks the layer sok or a clock", event)
		}
	}
	commands := named(events, "sok.command")
	if len(commands) != 1 {
		t.Fatalf("%d sok.command events in %+v", len(commands), events)
	}
	fields := commands[0].Fields
	if commands[0].Level != "warn" || fields["name"] != "nothing" || fields["ok"] != false || fields["status"] != float64(2) ||
		fields["error"] != "sok: unknown command: nothing" || fields["micros"] == nil {
		t.Fatalf("sok.command = %+v", commands[0])
	}
	if args, _ := fields["args"].(string); args != "nothing --config-dir "+config {
		t.Fatalf("args = %q", args)
	}

	passing := t.TempDir()
	if code, _, stderr := loggedRun(passing, sok.Run, "path", "remove"); code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	ok := named(eventsOf(t, passing), "sok.command")
	if len(ok) != 1 || ok[0].Level != "debug" || ok[0].Fields["ok"] != true || ok[0].Fields["status"] != float64(0) || ok[0].Fields["error"] != nil {
		t.Fatalf("sok.command of a command that succeeded = %+v", ok)
	}
}

// contract: cli.log.records-a-panic-with-its-stack
func TestAPanicOfACommandIsRecordedWithItsStack(t *testing.T) {
	config := t.TempDir()
	panics := func([]string, io.Writer, io.Writer, sok.Options) int { panic("the command broke") }
	var status int
	var stderr string
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				t.Errorf("the panic reached the caller: %v", recovered)
			}
		}()
		status, _, stderr = loggedRun(config, panics, "plugin", "list")
	}()
	if status != 4 || !strings.HasPrefix(stderr, "sok: panic: the command broke\n") {
		t.Fatalf("status %d stderr %q", status, stderr)
	}
	events := eventsOf(t, config)
	found := named(events, "sok.panic")
	if len(found) != 1 || found[0].Level != "error" || found[0].Fields["name"] != "main" || found[0].Fields["text"] != "the command broke" {
		t.Fatalf("sok.panic events = %+v", found)
	}
	if stack, _ := found[0].Fields["stack"].(string); !strings.Contains(stack, "TestAPanicOfACommandIsRecordedWithItsStack") {
		t.Fatalf("the stack does not name the test that panicked: %q", stack)
	}
	commands := named(events, "sok.command")
	if len(commands) != 1 || commands[0].Fields["ok"] != false || commands[0].Fields["status"] != float64(4) || commands[0].Fields["name"] != "plugin" {
		t.Fatalf("sok.command = %+v", commands)
	}
}

// contract: cli.log.records-a-panic-of-a-routine-and-ends-the-process
func TestAPanicOfARoutineIsRecordedAndEndsTheProcess(t *testing.T) {
	config := t.TempDir()
	child := exec.Command(os.Args[0], "-test.run=^TestRoutinePanicChild$")
	child.Env = append(os.Environ(), "SOK_ROUTINE_PANIC_CONFIG="+config)
	var stderr bytes.Buffer
	child.Stderr = &stderr
	err := child.Run()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 4 {
		t.Fatalf("the child ended with %v, want exit status 4; stderr %q", err, stderr.String())
	}
	found := named(eventsOf(t, config), "sok.panic")
	if len(found) != 1 || found[0].Fields["name"] != "worker" || found[0].Fields["text"] != "the routine broke" {
		t.Fatalf("sok.panic events = %+v; stderr %q", found, stderr.String())
	}
	if stack, _ := found[0].Fields["stack"].(string); !strings.Contains(stack, "TestRoutinePanicChild") {
		t.Fatalf("the stack does not name the function that panicked: %q", stack)
	}
}

// TestRoutinePanicChild is the process that TestAPanicOfARoutineIsRecordedAndEndsTheProcess starts; it does nothing in a
// regular run.
func TestRoutinePanicChild(t *testing.T) {
	config := os.Getenv("SOK_ROUTINE_PANIC_CONFIG")
	if config == "" {
		t.Skip("started by TestAPanicOfARoutineIsRecordedAndEndsTheProcess")
	}
	waits := func([]string, io.Writer, io.Writer, sok.Options) int {
		done := make(chan struct{})
		sok.Go("worker", func() { panic("the routine broke") })
		<-done
		return 0
	}
	loggedRun(config, waits, "windows")
}

// contract: cli.log.reports-a-folder-that-cannot-be-written
func TestAFolderThatCannotBeWrittenIsReportedAndTheCommandRuns(t *testing.T) {
	config := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(config, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := loggedRun(config, sok.Run, "path", "remove")
	if code != 0 || !strings.HasPrefix(stderr, "sok: event log: ") || !strings.Contains(stderr, config) {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}
