package tests

// Checks the record of connected applications (docs/spec/installation.md#applications): plugins/applications.json holds
// format 1 with the place and the way of each application, another form is refused with the file and what it found, and
// removing an application deletes the folder of an installed one and only the entry of a located one.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

func TestTheRecordHoldsEachApplicationWithItsPlaceAndWay(t *testing.T) {
	config := t.TempDir()
	applications, err := sok.ReadApplications(config)
	if err != nil || len(applications.Applications) != 0 {
		t.Fatalf("an absent record: %+v %v", applications, err)
	}
	located := sok.ApplicationRecord{Version: "1.0.0", Path: "/Applications/Sketcher.app/Contents/MacOS/sketcher", How: "located", Method: "bundle"}
	if err := sok.RecordApplication(config, "sketcher", located); err != nil {
		t.Fatal(err)
	}
	applications, err = sok.ReadApplications(config)
	if err != nil || applications.Format != 1 || applications.Applications["sketcher"] != located {
		t.Fatalf("the record: %+v %v", applications, err)
	}
}

func TestARecordOfAnotherFormIsRefusedWithTheFileAndWhatItFound(t *testing.T) {
	config := t.TempDir()
	path := filepath.Join(config, "plugins", "applications.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"format": 2, "applications": {}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := sok.ReadApplications(config)
	if err == nil || !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), "format must be 1") {
		t.Fatalf("err %v", err)
	}
}

func TestRemovingDeletesTheFolderOfAnInstalledApplicationAndOnlyTheEntryOfALocatedOne(t *testing.T) {
	config := t.TempDir()
	folder := filepath.Join(config, "applications", "sketcher", "1.0.0")
	if err := os.MkdirAll(filepath.Join(folder, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	executable(t, filepath.Join(folder, "bin", "sketcher"))
	outside := filepath.Join(t.TempDir(), "painter")
	executable(t, outside)
	if err := sok.RecordApplication(config, "sketcher", sok.ApplicationRecord{Version: "1.0.0", Path: filepath.Join(folder, "bin", "sketcher"), How: "installed", Method: "release"}); err != nil {
		t.Fatal(err)
	}
	if err := sok.RecordApplication(config, "painter", sok.ApplicationRecord{Version: "2.0.0", Path: outside, How: "located", Method: "path"}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"sketcher", "painter"} {
		if err := sok.RemoveApplication(config, id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(config, "applications", "sketcher")); !os.IsNotExist(err) {
		t.Fatalf("the installed application stayed: %v", err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("the located application was touched: %v", err)
	}
	applications, err := sok.ReadApplications(config)
	if err != nil || len(applications.Applications) != 0 {
		t.Fatalf("the record after removal: %+v %v", applications, err)
	}
}
