//go:build !mygo

package sok

import "testing"

// contract: cli.identity.build-identifier
func TestIdentityOfABuildWithoutTheMygoTagIsTheWailsIdentifier(t *testing.T) {
	// A build without the mygo tag is the sok of the Wails host; a build with the dev tag adds .dev.
	want := "app.soksak.wails"
	if devBuild {
		want += ".dev"
	}
	if identifier := Identity(); identifier != want {
		t.Fatalf("identity = %q, want %q", identifier, want)
	}
}
