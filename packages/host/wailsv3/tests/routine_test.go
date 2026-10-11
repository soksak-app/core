// The entrance of the goroutines of the host (docs/spec/hosts.md#process-lifecycle): a panic of a goroutine that started
// through routine.Go is the event `host.panic` in the event log before the process ends with status 2.
package host_test

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
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
		// The entrance ends the process; reaching the end of the wait is the failure.
		time.Sleep(10 * time.Second)
		os.Exit(4)
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestAPanicOfAGoroutineIsRecordedAsAnEventBeforeTheProcessEnds$")
	command.Env = append(os.Environ(), routineChild+"="+config)
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
}
