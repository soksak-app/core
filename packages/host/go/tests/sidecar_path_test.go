package host_test

// Checks the record of the folder that the environment of every sidecar puts first on PATH (docs/spec/sidecars.md#processes-of-a-surface).

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// contract: sidecars.environment.start-records-the-sok-folder
func TestTheStartRecordsTheFolderThatTheSidecarsPutFirstOnPath(t *testing.T) {
	log := support.UseEventLog(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	folder := filepath.Dir(executable)
	sidecars, err := host.NewInstalledSidecars(installedFixture(t))
	if err != nil {
		t.Fatalf("the start failed: %v", err)
	}
	sidecars.Stop()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var recorded []string
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "host.sidecar.path" {
			fields := event["fields"].(map[string]any)
			recorded = append(recorded, fmt.Sprintf("%s %v %v", event["level"], fields["folder"], fields["sok"]))
		}
	}
	if want := []string{"info " + folder + " " + filepath.Join(folder, "sok")}; !slices.Equal(recorded, want) {
		t.Fatalf("the start recorded %q, not %q", recorded, want)
	}
}
