// The standard error of the Wails host (docs/spec/diagnostics.md#files): the logger of the framework writes the lines of its
// asset server at the level info, one for every file that a page requests, so the host gives the logger the level that
// keeps the lines of a warning and of an error and leaves those lines out.
package adapter_test

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	adapter "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: diagnostics.stderr.leaves-out-asset-request-lines
func TestTheFrameworkLoggerLeavesOutTheLinesOfAssetRequests(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stderr
	os.Stderr = file
	logger := application.DefaultLogger(adapter.FrameworkLogLevel)
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

// A binding failure that the page receives is recorded once by the page. If the Wails transport that the host uses recorded that failure again,
// one failure would leave two lines (docs/spec/hosts.md#application-log).
// contract: log.binding-failure.returned-not-logged
func TestTheTransportReturnsAFailedCallWithoutLoggingIt(t *testing.T) {
	var logged strings.Builder
	transport := application.NewHTTPTransport(application.HTTPTransportWithLogger(slog.New(slog.NewTextHandler(&logged, nil))))
	handler := transport.Handler()(http.NotFoundHandler())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/wails/runtime", strings.NewReader("{}")))
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "missing object value") {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
	if logged.Len() != 0 {
		t.Fatalf("the transport logged the failure it returned: %q", logged.String())
	}
}
