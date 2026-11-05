//go:build darwin

package darwin

import "testing"

// A creation of a document region that the native layer fails reports the native cause after the creation error.
// contract: host.document.creation-error-states-the-cause
func TestCreateDocumentReportsTheNativeCause(t *testing.T) {
	failNextCreation("cannot create the data store directory /probe: test fault")
	_, err := implementation{}.CreateDocument(nil, "/probe", "", "probe", "", "", func(string) {})
	want := "cannot create a document view in this surface: cannot create the data store directory /probe: test fault"
	if err == nil || err.Error() != want {
		t.Fatalf("CreateDocument error %v, want %q", err, want)
	}
}

// A native layer that fails a creation without stating a cause is reported as such, so the error never hides that the cause is
// missing.
// contract: host.document.creation-error-states-the-cause
func TestCreateDocumentReportsAMissingNativeCause(t *testing.T) {
	failNextCreation("")
	_, err := implementation{}.CreateDocument(nil, "/probe", "", "probe", "", "", func(string) {})
	want := "cannot create a document view in this surface: the native layer stated no cause"
	if err == nil || err.Error() != want {
		t.Fatalf("CreateDocument error %v, want %q", err, want)
	}
}
