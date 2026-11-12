// Application log tests (docs/spec/hosts.md#application-log). Replacing the standard error affects the whole process,
// so it is checked in a child process.
package host_test

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// standardErrorChild is the environment variable that tells the child process the configuration directory.
const standardErrorChild = "SOKSAK_APPLICATION_LOG_CHILD"

// contract: log.open.rotates-at-100mb
func TestOpenLogMovesAFileOfOneHundredMegabytesToTheEarlierGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "application.log")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	full := strings.Repeat("x", 100*1024*1024)
	if err := os.WriteFile(path, []byte(full), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".1", []byte("older\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for generation := 2; generation <= 5; generation++ {
		if err := os.WriteFile(fmt.Sprintf("%s.%d", path, generation), []byte(fmt.Sprintf("generation %d\n", generation)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	file, err := host.OpenLog(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("new\n"); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	earlier, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatal(err)
	}
	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(earlier) != len(full) || string(current) != "new\n" {
		t.Fatalf("earlier generation %d bytes, current %q", len(earlier), current)
	}
	// The earlier generations move up by one and the fifth one is dropped.
	for generation, want := range map[int]string{2: "older\n", 3: "generation 2\n", 4: "generation 3\n", 5: "generation 4\n"} {
		data, err := os.ReadFile(fmt.Sprintf("%s.%d", path, generation))
		if err != nil || string(data) != want {
			t.Fatalf("generation %d is %q (%v), want %q", generation, data, err, want)
		}
	}
	if _, err := os.Stat(path + ".6"); !os.IsNotExist(err) {
		t.Fatalf("a sixth earlier generation was kept: %v", err)
	}
}

// contract: log.open.appends-below-bound
func TestOpenLogAppendsToASmallerFileAndCreatesAPrivateFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "application.log")
	for _, line := range []string{"first\n", "second\n"} {
		file, err := host.OpenLog(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.WriteString(line); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "first\nsecond\n" || info.Mode().Perm() != 0o600 {
		t.Fatalf("log %q with mode %v", data, info.Mode().Perm())
	}
	if _, err := os.Stat(path + ".1"); !os.IsNotExist(err) {
		t.Fatalf("a file below the bound was rotated: %v", err)
	}
}

// contract: log.application.start-replaces-standard-error
func TestStartStandardErrorWritesTheRunRecordAsAnEventAndTakesTheStandardErrorOfTheProcessAndItsChildren(t *testing.T) {
	if config := os.Getenv(standardErrorChild); config != "" {
		log, err := host.StartHostEventLog(config)
		if err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		support.StoreEveryLevel(t, log)
		host.UseHostEventLog(log)
		if err := host.StartStandardError(config, "com.soksak.test"); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		os.Stderr.WriteString("host line\n")
		child := exec.Command("/bin/sh", "-c", "echo child line >&2")
		child.Stderr = os.Stderr
		if err := child.Run(); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		if err := log.Flush(); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestStartStandardErrorWritesTheRunRecordAsAnEventAndTakesTheStandardErrorOfTheProcessAndItsChildren$")
	command.Env = append(os.Environ(), standardErrorChild+"="+config)
	if output, err := command.Output(); err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	// The raw standard error of the process and its children is in the stderr file of the run, beside the event log.
	stderr, err := filepath.Glob(filepath.Join(config, "logs", "host-*.stderr"))
	if err != nil || len(stderr) != 1 {
		t.Fatalf("stderr files %v, %v", stderr, err)
	}
	data, err := os.ReadFile(stderr[0])
	if err != nil {
		t.Fatal(err)
	}
	if got := string(data); got != "host line\nchild line\n" {
		t.Fatalf("stderr file %q", got)
	}
	// The run record is an event of the event log, not a line of the stderr file.
	events := readHostEventLog(t, config)
	run := events[len(events)-1]
	fields, _ := run["fields"].(map[string]any)
	if run["event"] != "host.record.info" || fields["where"] != "run" || !regexp.MustCompile(`^com\.soksak\.test pid \d+$`).MatchString(fields["text"].(string)) {
		t.Fatalf("event log %v", events)
	}
}

// crashOutputEndChild is the environment variable that tells the child process the configuration directory and whether the crash
// file of its run holds output before the normal exit ("empty" or "written").
const crashOutputEndChild = "SOKSAK_CRASH_OUTPUT_END_CHILD"

// runCrashOutputEnd starts this test binary as a host process that opens its standard error and crash files, writes to the crash
// file when written is true, and ends normally through EndCrashOutput; it returns the configuration directory.
func runCrashOutputEnd(t *testing.T, test string, written bool) string {
	t.Helper()
	config := t.TempDir()
	state := "empty"
	if written {
		state = "written"
	}
	command := exec.Command(os.Args[0], "-test.run=^"+test+"$")
	command.Env = append(os.Environ(), crashOutputEndChild+"="+state+":"+config)
	if output, err := command.Output(); err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	return config
}

// crashOutputEndInChild runs the host side of runCrashOutputEnd and reports whether this process is that child.
func crashOutputEndInChild() bool {
	value := os.Getenv(crashOutputEndChild)
	if value == "" {
		return false
	}
	state, config, _ := strings.Cut(value, ":")
	fail := func(err error) {
		os.Stdout.WriteString(err.Error() + "\n")
		os.Exit(2)
	}
	log, err := host.StartHostEventLog(config)
	if err != nil {
		fail(err)
	}
	host.UseHostEventLog(log)
	if err := host.StartStandardError(config, "com.soksak.test"); err != nil {
		fail(err)
	}
	if state == "written" {
		file, err := os.OpenFile(host.CrashOutputPath(config), os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			fail(err)
		}
		if _, err := file.WriteString("fatal error: output of an earlier fault\n"); err != nil {
			fail(err)
		}
		if err := file.Close(); err != nil {
			fail(err)
		}
	}
	if err := host.EndCrashOutput(config); err != nil {
		fail(err)
	}
	if err := log.Flush(); err != nil {
		fail(err)
	}
	return true
}

// A normal exit removes the crash file of its run when no fatal error wrote it, so the logs folder keeps a crash file only for a run
// that crashed; the standard error file stays (docs/spec/logging.md#files).
// contract: log.crash-file.normal-exit-removes-an-empty-file
func TestANormalExitRemovesTheEmptyCrashFileOfItsRun(t *testing.T) {
	if crashOutputEndInChild() {
		return
	}
	config := runCrashOutputEnd(t, "TestANormalExitRemovesTheEmptyCrashFileOfItsRun", false)
	crash, err := filepath.Glob(filepath.Join(config, "logs", "host-*.crash"))
	if err != nil || len(crash) != 0 {
		t.Fatalf("crash files after a normal exit %v, %v", crash, err)
	}
	stderr, err := filepath.Glob(filepath.Join(config, "logs", "host-*.stderr"))
	if err != nil || len(stderr) != 1 {
		t.Fatalf("stderr files %v, %v", stderr, err)
	}
}

// contract: log.crash-file.normal-exit-keeps-a-file-with-output
func TestANormalExitKeepsACrashFileThatHoldsOutput(t *testing.T) {
	if crashOutputEndInChild() {
		return
	}
	config := runCrashOutputEnd(t, "TestANormalExitKeepsACrashFileThatHoldsOutput", true)
	crash, err := filepath.Glob(filepath.Join(config, "logs", "host-*.crash"))
	if err != nil || len(crash) != 1 {
		t.Fatalf("crash files after a normal exit %v, %v", crash, err)
	}
	data, err := os.ReadFile(crash[0])
	if err != nil {
		t.Fatal(err)
	}
	if got := string(data); got != "fatal error: output of an earlier fault\n" {
		t.Fatalf("crash file %q", got)
	}
}

// contract: log.error.line-form
func TestLogErrorWritesAnErrorEventToTheEventLog(t *testing.T) {
	if config := os.Getenv(standardErrorChild); config != "" {
		log, err := host.StartHostEventLog(config)
		if err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		support.StoreEveryLevel(t, log)
		host.UseHostEventLog(log)
		host.LogError("surface input", errors.New("the window has no content view"))
		if err := log.Flush(); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestLogErrorWritesAnErrorEventToTheEventLog$")
	command.Env = append(os.Environ(), standardErrorChild+"="+config)
	if output, err := command.Output(); err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	events := readHostEventLog(t, config)
	if len(events) != 3 || events[2]["event"] != "host.record.error" || events[2]["level"] != "error" ||
		events[2]["fields"].(map[string]any)["where"] != "surface input" ||
		events[2]["fields"].(map[string]any)["text"] != "the window has no content view" {
		t.Fatalf("event log %v", events)
	}
}

// A record is one line: a line feed in its text is written as the two characters `\n`.
// contract: log.record.one-line
func TestARecordIsOneLineAndEscapesALineFeed(t *testing.T) {
	line := host.Entry{Level: "error", Layer: "workbench", Where: "start", Text: "first\nsecond"}.Line()
	if want := `error workbench start: first\nsecond`; line != want {
		t.Fatalf("line %q, want %q", line, want)
	}
	if strings.Contains(host.Entry{Level: "info", Layer: "host", Where: "w", Text: "a\nb"}.Line(), "\n") {
		t.Fatal("a record holds a line feed")
	}
}

// A host observation is a record of level info through LogInfo.
// contract: log.info.record-form
func TestLogInfoWritesAnInfoEventToTheEventLog(t *testing.T) {
	if config := os.Getenv(standardErrorChild); config != "" {
		log, err := host.StartHostEventLog(config)
		if err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		support.StoreEveryLevel(t, log)
		host.UseHostEventLog(log)
		host.LogInfo("webkit children", "pid 7: gone")
		if err := log.Flush(); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestLogInfoWritesAnInfoEventToTheEventLog$")
	command.Env = append(os.Environ(), standardErrorChild+"="+config)
	if output, err := command.Output(); err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	events := readHostEventLog(t, config)
	if len(events) != 3 || events[2]["event"] != "host.record.info" || events[2]["level"] != "info" ||
		events[2]["fields"].(map[string]any)["where"] != "webkit children" ||
		events[2]["fields"].(map[string]any)["text"] != "pid 7: gone" {
		t.Fatalf("event log %v", events)
	}
}

// readHostEventLog returns the events of the only host event log under the logs folder of a configuration folder.
func readHostEventLog(t *testing.T, config string) []map[string]any {
	t.Helper()
	// The activity observers that the writer installs store native events of their own; these checks concern the host.
	var events []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["layer"] != "native" {
			events = append(events, event)
		}
	}
	return events
}

// A line of the diagnostic transcript of a window, and an error that the transcript carries, also reach the application log.
// contract: log.transcript.line-reaches-the-application-log
func TestTranscriptLinesReachTheApplicationLog(t *testing.T) {
	if got, want := host.TranscriptEntry("main", "diagnostics: modal rendered m1").Line(),
		"info host transcript main: diagnostics: modal rendered m1"; got != want {
		t.Fatalf("transcript line = %q, want %q", got, want)
	}
	if got, want := host.TranscriptFailure("main", "rewatch core.layout", errors.New("page timed out")).Line(),
		"error host rewatch core.layout main: page timed out"; got != want {
		t.Fatalf("transcript failure = %q, want %q", got, want)
	}
}
