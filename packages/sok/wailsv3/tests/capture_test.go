//go:build !diagnostics

package tests

import (
	"strings"
	"testing"
)

// contract: cli.diagnostics.capture-only-in-diagnostic-builds
func TestCaptureNeedsADiagnosticBuild(t *testing.T) {
	code, stdout, stderr := run("capture", "--config-dir", t.TempDir())
	if code != 2 || stdout != "" || !strings.HasPrefix(stderr, "sok: capture needs a diagnostic build of sok\n") {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}
