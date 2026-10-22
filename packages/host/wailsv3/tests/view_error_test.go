package host_test

import (
	"os"
	"os/exec"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// viewRecordChild names the configuration folder of the child process that runs a view record test, so the writer of the child holds
// only the records of that test.
const viewRecordChild = "SOKSAK_VIEW_RECORD_CHILD"

// runViewRecordChild runs the test name in a child process of this test binary and returns the configuration folder it wrote.
func runViewRecordChild(t *testing.T, name string) string {
	t.Helper()
	config := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run", "^"+name+"$", "-test.count=1")
	cmd.Env = append(os.Environ(), viewRecordChild+"="+config)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child %s: %v: %s", name, err, out)
	}
	return config
}

// contract: view.error.display
// A view.error message of a view is written once on the error display path with the plugin and surface of the view
// (docs/spec/native-surfaces.md#view-surfaces), and the message is accepted: a page that fails before its first call reports it.
func TestViewErrorMessageIsWrittenOnTheErrorDisplayPathWithItsView(t *testing.T) {
	if config := os.Getenv(viewRecordChild); config != "" {
		log := support.StartWriter(t, config)
		s := host.NewSurfaces(nil, nil)
		s.RegisterView("probe-surface", "probe")
		if err := s.ViewMessage("probe-surface", `{"message":{"event":"view.error","plugin":"probe","reason":"uncaught error: boom"}}`); err != nil {
			t.Fatalf("view.error message: %v, want the message accepted and written as a record", err)
		}
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		return
	}
	config := runViewRecordChild(t, "TestViewErrorMessageIsWrittenOnTheErrorDisplayPathWithItsView")
	var errors []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] == "host.record.error" {
			errors = append(errors, event["fields"].(map[string]any))
		}
	}
	if len(errors) != 1 || errors[0]["where"] != "view probe probe-surface" || errors[0]["text"] != "uncaught error: boom" {
		t.Fatalf("host.record.error records: %v, want exactly one with where %q and text %q", errors, "view probe probe-surface", "uncaught error: boom")
	}
}
