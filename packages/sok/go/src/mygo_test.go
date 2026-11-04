//go:build mygo

package sok

import "testing"

// contract: cli.identity.build-identifier
func TestIdentityOfABuildWithTheMygoTagIsTheMygoIdentifier(t *testing.T) {
	// A build with the mygo tag is the sok of the mygo host; a build with the dev tag adds .dev.
	want := "app.soksak.mygo"
	if devBuild {
		want += ".dev"
	}
	if identifier := Identity(); identifier != want {
		t.Fatalf("identity = %q, want %q", identifier, want)
	}
}
