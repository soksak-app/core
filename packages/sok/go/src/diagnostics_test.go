//go:build diagnostics && !dev

package sok

import (
	"encoding/json"
	"testing"
)

// contract: cli.diagnostics.capture-only-in-diagnostic-builds
func TestCaptureRequestIsADiagnosticCommand(t *testing.T) {
	if captureRequest == nil {
		t.Fatal("the diagnostic build has no capture request")
	}
	req, err := captureRequest("main")
	if err != nil {
		t.Fatal(err)
	}
	params, _ := json.Marshal(req.params)
	if req.method != "diagnostics.capture.still" || string(params) != `{"window":"main"}` {
		t.Fatalf("capture request = %s %s", req.method, params)
	}
}

// contract: cli.identity.build-identifier
func TestADiagnosticBuildWithoutTheDevTagUsesTheReleaseIdentifier(t *testing.T) {
	// A 0.0.x release is a diagnostic build and reads the configuration folder of the installed application.
	if identifier := Identity(); identifier != "app.soksak.wails" {
		t.Fatalf("identity = %q", identifier)
	}
}
