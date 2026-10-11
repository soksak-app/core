// The standard error of the Wails host (docs/spec/diagnostics.md#files): the logger of the framework writes the lines of its
// asset server at the level info, one for every file that a page requests, so the host gives the logger the level that
// keeps the lines of a warning and of an error and leaves those lines out.
package host_test

import (
	"os"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: diagnostics.stderr.leaves-out-asset-request-lines
func TestTheFrameworkLoggerLeavesOutTheLinesOfAssetRequests(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stderr
	os.Stderr = file
	logger := application.DefaultLogger(host.FrameworkLogLevel)
	os.Stderr = original
	logger.Info("[AssetFileServerFS] Handling request", "url", "/modules/app.js", "file", "modules/app.js")
	logger.Warn("a warning of the framework")
	logger.Error("an error of the framework")
	data, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "Handling request") || !strings.Contains(text, "a warning of the framework") || !strings.Contains(text, "an error of the framework") {
		t.Fatalf("the standard error holds %q", text)
	}
}
