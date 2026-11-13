package nativeprod

import (
	"fmt"
	"os"
	"testing"
)

// TestNativeEnvironment writes the environment that the test binary received, and the linked value, to the file that
// SOKSAK_FIXTURE_REPORT names.
func TestNativeEnvironment(t *testing.T) {
	report := os.Getenv("SOKSAK_FIXTURE_REPORT")
	if report == "" {
		t.Fatal("SOKSAK_FIXTURE_REPORT is not set")
	}
	text := fmt.Sprintf("CGO_ENABLED=%s\nSOKSAK_NATIVE_LIBRARY=%s\nSOKSAK_NATIVE_TEST_LIBRARY=%s\nvalue=%s\n",
		os.Getenv("CGO_ENABLED"), os.Getenv("SOKSAK_NATIVE_LIBRARY"), os.Getenv("SOKSAK_NATIVE_TEST_LIBRARY"), Value())
	if err := os.WriteFile(report, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}
