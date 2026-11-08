//go:build darwin

package system_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// contract: diagnostics.crash.folder-is-named-by-the-platform
func TestThePlatformNamesTheFolderOfCrashReports(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	directory, err := system.DiagnosticReportsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(directory) || !strings.HasSuffix(directory, "/Library/Logs/DiagnosticReports") {
		t.Fatalf("the folder of the crash reports is %q", directory)
	}
}
