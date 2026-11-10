package sok

import "testing"

// contract: cli.identity.build-identifier
func TestEachGoHostHasTheIdentifierOfItsApplication(t *testing.T) {
	// The host takes its identifier from the application name of its framework adapter, so a host build that misses the
	// build tag of its sok still uses its own configuration folder; the tag only names the host of the sok command.
	suffix := ""
	if devBuild {
		suffix = ".dev"
	}
	for application, want := range map[string]string{"wailsv3": "app.soksak.wails", "mygo": "app.soksak.mygo"} {
		identifier, err := IdentityOf(application)
		if err != nil || identifier != want+suffix {
			t.Fatalf("IdentityOf(%q) = %q, %v; want %q", application, identifier, err, want+suffix)
		}
	}
	if identifier, err := IdentityOf("tauriv2"); err == nil {
		t.Fatalf("IdentityOf(tauriv2) = %q, want an error: the Rust host has its own identity", identifier)
	}
	if identifier, err := IdentityOf(Application); err != nil || identifier != Identity() {
		t.Fatalf("IdentityOf(Application) = %q, %v; want Identity() %q", identifier, err, Identity())
	}
}
