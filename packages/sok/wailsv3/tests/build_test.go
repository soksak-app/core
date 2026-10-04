//go:build !diagnostics

package tests

// 진단 build 가 아닌 sok 의 검사다. Go 파일은 build 제약으로 한 build 에만 속하므로 진단 build 의 검사는
// src/diagnostics_test.go 에 있다(docs/spec/hosts.md 차이 C2).

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
