// A failure that ends the process records its exit code after its error record, so a reader of the log learns how the process
// ended without its shutdown.
package host

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// startFatalExitWriter makes a writer that stores every level the writer of the records of the host until the test ends.
func startFatalExitWriter(t *testing.T, config string) {
	t.Helper()
	log, err := StartHostEventLog(config)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := ParseLogPolicy("fatal exit test policy", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`))
	if err != nil {
		log.Close()
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
	UseHostEventLog(log)
	t.Cleanup(func() {
		UseHostEventLog(nil)
		log.Close()
	})
}

// fatalExitEvents are the events of the host logs of config.
func fatalExitEvents(t *testing.T, config string) []map[string]any {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(config, "logs", "host-*.jsonl"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("host event logs %v, %v", paths, err)
	}
	var events []map[string]any
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
			var event map[string]any
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				t.Fatalf("event log %s holds a line that is not JSON: %v", path, err)
			}
			events = append(events, event)
		}
	}
	return events
}

// contract: log.closed.fatal-exit-code
func TestAFatalErrorRecordsTheExitCodeAfterItsErrorRecord(t *testing.T) {
	if config := os.Getenv("SOKSAK_FATAL_EXIT_CHILD"); config != "" {
		startFatalExitWriter(t, config)
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
	for _, event := range fatalExitEvents(t, config) {
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
