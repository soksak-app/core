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

func TestLocateFindsACommandOnThePath(t *testing.T) {
	folder := t.TempDir()
	executable(t, filepath.Join(folder, "fake-editor"))
	located, found, err := sok.LocateApplication([]map[string]string{{"command": "fake-editor"}}, "editor", folder)
	if err != nil || !found {
		t.Fatalf("found %v, err %v", found, err)
	}
	if located.Path != filepath.Join(folder, "fake-editor") || located.Method != "command" {
		t.Fatalf("located %+v", located)
	}
}

func TestLocateTriesEachWayInOrderAndTakesTheFirstThatFinds(t *testing.T) {
	folder := t.TempDir()
	present := filepath.Join(folder, "editor")
	executable(t, present)
	ways := []map[string]string{{"command": "absent-editor"}, {"path": filepath.Join(folder, "missing")}, {"path": present}}
	located, found, err := sok.LocateApplication(ways, "editor", t.TempDir())
	if err != nil || !found || located.Path != present || located.Method != "path" {
		t.Fatalf("located %+v, found %v, err %v", located, found, err)
	}
}

func TestLocateDoesNotTakeAFileThatIsNotExecutable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "editor")
	if err := os.WriteFile(path, []byte("text"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, found, err := sok.LocateApplication([]map[string]string{{"path": path}, {"command": "absent-editor"}}, "editor", t.TempDir())
	if err != nil || found {
		t.Fatalf("found %v, err %v", found, err)
	}
}

// A bundle identifier is found through the metadata index of darwin, and another platform refuses the entry.
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
