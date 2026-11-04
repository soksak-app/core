//go:build dev

package sok

import "testing"

// contract: cli.identity.build-identifier
func TestTheDevBuildUsesTheDevelopmentIdentifier(t *testing.T) {
	// A debug build runs beside the installed application, so it uses its own configuration folder.
	if identifier := Identity(); identifier != "app.soksak.wails.dev" {
		t.Fatalf("identity = %q", identifier)
	}
}
