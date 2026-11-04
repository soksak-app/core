//go:build dev

package sok

import "testing"

// contract: cli.identity.build-identifier
func TestIdentityOfTheDevBuildIsTheReleaseIdentifierWithDev(t *testing.T) {
	// A debug build runs beside the installed application, so it uses its own configuration folder.
	if identifier := Identity(); identifier != ReleaseIdentifier+".dev" {
		t.Fatalf("identity = %q, want %q", identifier, ReleaseIdentifier+".dev")
	}
}
