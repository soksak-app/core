//go:build diagnostics

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
