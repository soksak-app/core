//go:build darwin

package testlibrary_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/testlibrary"
)

func TestOpenRequiresAnExplicitAbsoluteNativeArtifact(t *testing.T) {
	const variable = "SOKSAK_TEST_LIBRARY_INVALID_ARTIFACT"
	// Preserve even an explicitly empty inherited variable, because all artifact
	// configuration belongs to the caller of this test process.
	before, present := os.LookupEnv(variable)
	t.Cleanup(func() {
		if present {
			_ = os.Setenv(variable, before)
		} else {
			_ = os.Unsetenv(variable)
		}
	})
	folder := t.TempDir()
	invalid := filepath.Join(folder, "invalid.dylib")
	if err := os.WriteFile(invalid, []byte("this is not a Mach-O native library\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name     string
		value    string
		unset    bool
		contains string
	}{
		{name: "unset", unset: true, contains: "absolute"},
		{name: "empty", contains: "absolute"},
		{name: "relative", value: "relative-native.dylib", contains: "absolute"},
		{name: "missing", value: filepath.Join(folder, "missing.dylib"), contains: "missing.dylib"},
		{name: "directory", value: folder, contains: "not a regular file"},
		{name: "invalid Mach-O", value: invalid, contains: "load native library"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var err error
			if scenario.unset {
				err = os.Unsetenv(variable)
			} else {
				err = os.Setenv(variable, scenario.value)
			}
			if err != nil {
				t.Fatal(err)
			}
			handle, err := testlibrary.Open(variable)
			if err == nil || handle != 0 || !strings.Contains(err.Error(), variable) || !strings.Contains(err.Error(), scenario.contains) {
				t.Fatalf("invalid artifact returned handle %d, error %v", handle, err)
			}
			if filepath.IsAbs(scenario.value) && !strings.Contains(err.Error(), scenario.value) {
				t.Fatalf("native artifact error omitted its declared path: %v", err)
			}
		})
	}
}

func TestOpenRetainsTheDeclaredLibraryAndReportsMissingSymbols(t *testing.T) {
	// This is the same declared fixture artifact used by the native adapter tests.
	// Absence is a configuration failure, never a skipped integration check.
	path, present := os.LookupEnv("SOKSAK_NATIVE_TEST_LIBRARY")
	if !present || path == "" || !filepath.IsAbs(path) {
		t.Fatal("SOKSAK_NATIVE_TEST_LIBRARY must name the required absolute native test artifact")
	}
	first, err := testlibrary.Open("SOKSAK_NATIVE_TEST_LIBRARY")
	if err != nil || first == 0 {
		t.Fatalf("open declared native test artifact: handle %d, %v", first, err)
	}
	second, err := testlibrary.Open("SOKSAK_NATIVE_TEST_LIBRARY")
	if err != nil || second != first {
		t.Fatalf("same artifact changed identity: first %d, second %d, error %v", first, second, err)
	}
	address, err := testlibrary.Symbol(first, "sp_host_test_direct_runner_address")
	if err != nil || address == 0 {
		t.Fatalf("declared native fixture symbol: address %d, error %v", address, err)
	}
	const missing = "sp_host_test_deliberately_missing_symbol"
	if address, err := testlibrary.Symbol(first, missing); err == nil || address != 0 || !strings.Contains(err.Error(), missing) {
		t.Fatalf("missing native symbol returned address %d, error %v", address, err)
	}
}
