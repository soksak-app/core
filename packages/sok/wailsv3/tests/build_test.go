//go:build !diagnostics

package tests

// These are checks of the sok that is not a diagnostic build. A Go file belongs to one build through its build
// constraint, so the checks of the diagnostic build are in src/diagnostics_test.go (docs/spec/hosts.md difference C2).

import (
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// contract: cli.diagnostics.capture-only-in-diagnostic-builds
func TestCaptureNeedsADiagnosticBuild(t *testing.T) {
	code, stdout, stderr := run("capture", "--config-dir", t.TempDir())
	if code != 2 || stdout != "" || !strings.HasPrefix(stderr, "sok: capture needs a diagnostic build of sok\n") {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.identity.build-identifier
func TestTheReleaseBuildUsesTheReleaseIdentifier(t *testing.T) {
	if identifier := sok.Identity(); identifier != "app.soksak.wails" {
		t.Fatalf("identity = %q", identifier)
	}
}
