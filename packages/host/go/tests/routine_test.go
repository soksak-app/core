// The entrance of the goroutines of the host (docs/spec/hosts.md#process-lifecycle): a panic of a goroutine that started
// through routine.Go is the event `host.panic` in the event log before the process ends with status 2.
package host_test

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

const routineChild = "SOKSAK_ROUTINE_CHILD"

// contract: log.panic.records-an-event
func TestAPanicOfAGoroutineIsRecordedAsAnEventBeforeTheProcessEnds(t *testing.T) {
	if config := os.Getenv(routineChild); config != "" {
		log, err := host.StartHostEventLog(config)
		if err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(3)
		}
		host.UseHostEventLog(log)
		routine.Go("probe", func() { panic("the window has no content view") })
		// The entrance ends the process; the read blocks in a system call until then, so the runtime reports no deadlock.
		// Reaching its end is the failure.
		io.ReadAll(os.Stdin)
		os.Exit(4)
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestAPanicOfAGoroutineIsRecordedAsAnEventBeforeTheProcessEnds$")
	command.Env = append(os.Environ(), routineChild+"="+config)
	// The parent holds the standard input of the child open until the child ended.
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	output, err := command.CombinedOutput()
	var ended *exec.ExitError
	if !errors.As(err, &ended) || ended.ExitCode() != 2 {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	if !strings.Contains(string(output), "the window has no content view") {
		t.Fatalf("the standard error does not hold the panic: %q", output)
	}
	var panics []map[string]any
	for _, event := range readHostEventLog(t, config) {
		if event["event"] == "host.panic" {
			panics = append(panics, event)
		}
	}
	if len(panics) != 1 {
		t.Fatalf("host.panic events %v", panics)
	}
	fields := panics[0]["fields"].(map[string]any)
	stack, _ := fields["stack"].(string)
	if panics[0]["level"] != "error" || fields["name"] != "probe" || fields["text"] != "the window has no content view" ||
		!strings.Contains(stack, "routine_test.go") {
		t.Fatalf("host.panic event %v", panics[0])
	}
	// The process ends without its shutdown, so the record of its end after the panic names the exit code.
	var closed []any
	for _, event := range readHostEventLog(t, config) {
		if event["event"] == "log.closed" {
			closed = append(closed, event["fields"])
		}
	}
	if len(closed) != 1 || closed[0].(map[string]any)["cause"] != "exit" || closed[0].(map[string]any)["code"] != float64(routine.PanicStatus) {
		t.Fatalf("log.closed events %v, want one of the cause exit and the code %d", closed, routine.PanicStatus)
	}
}

const routineBeforeWriterChild = "SOKSAK_ROUTINE_BEFORE_WRITER_CHILD"

// contract: log.panic.before-writer-is-stored-when-the-writer-opens
func TestAPanicBeforeTheWriterExistsIsRecordedWhenTheWriterOpens(t *testing.T) {
	if config := os.Getenv(routineBeforeWriterChild); config != "" {
		// The panic happens before the writer exists; the writer opens after the entrance handed the panic to its record, as the
		// start of the host does.
		record, handed := routine.Record, make(chan struct{})
		routine.Record = func(name, text, stack string) {
			close(handed)
			record(name, text, stack)
		}
		routine.Go("probe", func() { panic("the lock directory cannot be read") })
		<-handed
		log, err := host.StartHostEventLog(config)
		if err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(3)
		}
		host.UseHostEventLog(log)
		// The entrance ends the process; the read blocks in a system call until then, so the runtime reports no deadlock.
		// Reaching its end is the failure.
		io.ReadAll(os.Stdin)
		os.Exit(4)
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestAPanicBeforeTheWriterExistsIsRecordedWhenTheWriterOpens$")
	command.Env = append(os.Environ(), routineBeforeWriterChild+"="+config)
	// The parent holds the standard input of the child open until the child ended.
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	output, err := command.CombinedOutput()
	var ended *exec.ExitError
	if !errors.As(err, &ended) || ended.ExitCode() != 2 {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	var panics []map[string]any
	for _, event := range readHostEventLog(t, config) {
		if event["event"] == "host.panic" {
			panics = append(panics, event)
		}
	}
	if len(panics) != 1 {
		t.Fatalf("host.panic events %v, want one", panics)
	}
	fields := panics[0]["fields"].(map[string]any)
	if fields["name"] != "probe" || fields["text"] != "the lock directory cannot be read" {
		t.Fatalf("host.panic event %v", panics[0])
	}
}

const routineNoWriterChild = "SOKSAK_ROUTINE_NO_WRITER_CHILD"

// contract: log.panic.without-writer-is-written-to-the-standard-error
func TestAPanicThatNoWriterStoresIsWrittenToTheStandardErrorInFull(t *testing.T) {
	if order := os.Getenv(routineNoWriterChild); order != "" {
		// No writer opens in this process. The start of the host ends without attaching one, before or after the panic waits
		// for the writer, and that end ends the wait.
		if order == "start-ended-first" {
			host.NotifyStartEnded()
		}
		record, handed := routine.Record, make(chan struct{})
		routine.Record = func(name, text, stack string) {
			close(handed)
			record(name, text, stack)
		}
		routine.Go("probe", func() { panic("the lock directory cannot be read") })
		<-handed
		if order == "panic-first" {
			host.NotifyStartEnded()
		}
		// The entrance ends the process; the read blocks in a system call until then, so the runtime reports no deadlock.
		// Reaching its end is the failure.
		io.ReadAll(os.Stdin)
		os.Exit(4)
	}
	for _, order := range []string{"panic-first", "start-ended-first"} {
		t.Run(order, func(t *testing.T) {
			command := exec.Command(os.Args[0], "-test.run=^TestAPanicThatNoWriterStoresIsWrittenToTheStandardErrorInFull$")
			command.Env = append(os.Environ(), routineNoWriterChild+"="+order)
			// The parent holds the standard input of the child open until the child ended.
			stdin, err := command.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			defer stdin.Close()
			output, err := command.CombinedOutput()
			var ended *exec.ExitError
			if !errors.As(err, &ended) || ended.ExitCode() != 2 {
				t.Fatalf("child ended with %v, output %q", err, output)
			}
			stderr := string(output)
			if !strings.Contains(stderr, "the record of the panic is not stored: the start of the host ended without a writer") ||
				!strings.Contains(stderr, "host.panic name=probe") || !strings.Contains(stderr, "text=") ||
				!strings.Contains(stderr, "the lock directory cannot be read") {
				t.Fatalf("the standard error does not hold the record of the panic: %q", stderr)
			}
		})
	}
}
