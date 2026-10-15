package tests

// Checks how the installer finds an installed application of a connector plugin (docs/spec/installation.md#applications):
// each locate entry is tried in order, and the first that finds the application gives its executable and the method. The
// search path of a command is an argument, which the installer takes from PATH.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/linux"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/windows"
)

// executable writes an executable file at the path.
func executable(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

// contract: application.locate.command-on-search-path
func TestLocateFindsACommandOnThePath(t *testing.T) {
	folder := t.TempDir()
	executable(t, filepath.Join(folder, "fake-sketcher"))
	located, found, err := sok.LocateApplication([]map[string]string{{"command": "fake-sketcher"}}, "sketcher", folder)
	if err != nil || !found {
		t.Fatalf("found %v, err %v", found, err)
	}
	if located.Path != filepath.Join(folder, "fake-sketcher") || located.Method != "command" {
		t.Fatalf("located %+v", located)
	}
}

// contract: application.locate.first-way-that-finds
func TestLocateTriesEachWayInOrderAndTakesTheFirstThatFinds(t *testing.T) {
	folder := t.TempDir()
	present := filepath.Join(folder, "sketcher")
	executable(t, present)
	ways := []map[string]string{{"command": "absent-sketcher"}, {"path": filepath.Join(folder, "missing")}, {"path": present}}
	located, found, err := sok.LocateApplication(ways, "sketcher", t.TempDir())
	if err != nil || !found || located.Path != present || located.Method != "path" {
		t.Fatalf("located %+v, found %v, err %v", located, found, err)
	}
}

// contract: application.locate.skips-non-executable
func TestLocateDoesNotTakeAFileThatIsNotExecutable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sketcher")
	if err := os.WriteFile(path, []byte("text"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, found, err := sok.LocateApplication([]map[string]string{{"path": path}, {"command": "absent-sketcher"}}, "sketcher", t.TempDir())
	if err != nil || found {
		t.Fatalf("found %v, err %v", found, err)
	}
}

// A bundle identifier is found through the metadata index of darwin, and another platform refuses the entry.
// contract: application.locate.bundle-by-identifier
func TestLocateFindsABundleByItsIdentifier(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	key, err := current.Key()
	if err != nil {
		t.Fatal(err)
	}
	located, found, err := sok.LocateApplication([]map[string]string{{"bundle": "com.apple.finder"}}, "Finder.app/Contents/MacOS/Finder", "")
	if !strings.HasPrefix(key, "darwin-") {
		if err == nil || !strings.Contains(err.Error(), "not implemented on") {
			t.Fatalf("%s: err %v", key, err)
		}
		return
	}
	if err != nil || !found {
		t.Fatalf("found %v, err %v", found, err)
	}
	if located.Path != "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder" || located.Method != "bundle" {
		t.Fatalf("located %+v", located)
	}
}

// contract: application.locate.appid-by-platform
func TestLocateByApplicationIdentifierIsNotImplementedYet(t *testing.T) {
	_, _, err := sok.LocateApplication([]map[string]string{{"appid": "com.example.Sketcher"}}, "sketcher", "")
	current, platformErr := platform.Current()
	if platformErr != nil {
		t.Fatal(platformErr)
	}
	system, _ := current.PackageManager()
	want := "locate entry 0: application identifiers are not implemented on " + system
	if err == nil || err.Error() != want {
		t.Fatalf("err %v, want %q", err, want)
	}
}
