//go:build darwin

package darwin

import "testing"

// A creation of a document region that the native layer fails reports the native cause after the creation error.
// contract: host.document.creation-error-states-the-cause
func TestCreateDocumentReportsTheNativeCause(t *testing.T) {
	failNextCreation("cannot create the data store directory /probe: test fault")
	_, err := implementation{}.CreateDocument(nil, "/probe", "", "probe", "", func(string) {})
	want := "cannot create a document view in this surface: cannot create the data store directory /probe: test fault"
	if err == nil || err.Error() != want {
		t.Fatalf("CreateDocument error %v, want %q", err, want)
	}
}

// A creation of a plugin host web view that the native layer fails reports the native cause after the creation error.
// contract: host.document.creation-error-states-the-cause
func TestCreatePluginHostReportsTheNativeCause(t *testing.T) {
	failNextCreation("the version of /Applications/Safari.app cannot be read")
	_, err := implementation{}.CreatePluginHost(nil, "/probe", "", "probe", "channel", func(string) {})
	want := "cannot create a plugin host web view in this window: the version of /Applications/Safari.app cannot be read"
	if err == nil || err.Error() != want {
		t.Fatalf("CreatePluginHost error %v, want %q", err, want)
	}
}
