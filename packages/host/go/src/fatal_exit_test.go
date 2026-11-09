// A failure that ends the process records its exit code after its error record, so a reader of the log learns how the process
// ended without its shutdown.
package host

import (
	"errors"
	"os"
	"os/exec"
	"reflect"
	"testing"
)

// contract: log.closed.fatal-exit-code
func TestAFatalErrorRecordsTheExitCodeAfterItsErrorRecord(t *testing.T) {
	if config := os.Getenv("SOKSAK_FATAL_EXIT_CHILD"); config != "" {
		startQuitSourceWriter(t, config)
		fatalError("probe", "the probe failed")
		return
	}
	config := t.TempDir()
	child := exec.Command(os.Args[0], "-test.run=^TestAFatalErrorRecordsTheExitCodeAfterItsErrorRecord$")
	child.Env = append(os.Environ(), "SOKSAK_FATAL_EXIT_CHILD="+config)
	output, err := child.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 {
		t.Fatalf("the child ended with %v, want exit status 1; output %s", err, output)
	}
	var ending []map[string]any
	for _, event := range quitSourceEvents(t, config) {
		if event["event"] == "host.record.error" || event["event"] == "log.closed" {
			ending = append(ending, map[string]any{"event": event["event"], "fields": event["fields"]})
		}
	}
	if len(ending) == 0 {
		t.Fatal("the log of the child holds no error record and no closing record")
	}
	want := []map[string]any{
		{"event": "host.record.error", "fields": map[string]any{"site": ending[0]["fields"].(map[string]any)["site"], "text": "the probe failed", "where": "probe"}},
		{"event": "log.closed", "fields": map[string]any{"cause": "exit", "code": float64(1)}},
	}
	if !reflect.DeepEqual(ending, want) {
		t.Fatalf("the end of the log = %v, want %v", ending, want)
	}
}
