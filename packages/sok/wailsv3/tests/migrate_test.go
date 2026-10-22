package tests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// The released form of plugins/installed.json of format 2, with the `package` member and `^` ranges, exactly as an
// earlier release wrote it.
const releasedFormat2 = `{
  "format": 2,
  "plugins": {
    "probe": {
      "package": "@scope/plugin-probe",
      "version": "0.0.4",
      "path": "plugins/probe/0.0.4",
      "enabled": true,
      "sidecars": {},
      "previous": "0.0.3"
    },
    "probe2": {
      "package": "@scope/plugin-probe2",
      "version": "0.0.2",
      "path": "plugins/probe2/0.0.2",
      "enabled": true,
      "sidecars": {
        "@scope/sidecar-probe": "^0.0.4"
      }
    }
  },
  "sidecars": {
    "@scope/sidecar-probe": {
      "version": "0.0.4",
      "path": "sidecars/scope-sidecar-probe/0.0.4/darwin-arm64"
    }
  }
}`

// writeReleasedFolders writes the plugin.json of each folder that releasedFormat2 records, as an installation extracts them.
func writeReleasedFolders(t *testing.T, config string) {
	t.Helper()
	for id, version := range map[string]string{"probe": "0.0.4", "probe2": "0.0.2"} {
		dir := filepath.Join(config, "plugins", id, version)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(`{"id":"`+id+`"}`), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func writeInstalledRaw(t *testing.T, config, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(config, "plugins"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config, "plugins", "installed.json"), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// contract: install.migration.migrates-the-released-form
func TestMigrateInstalledMigratesTheReleasedFormat2ToTheCurrentFormat(t *testing.T) {
	config := t.TempDir()
	writeInstalledRaw(t, config, releasedFormat2)
	writeReleasedFolders(t, config)
	if _, err := sok.MigrateInstalled(config); err != nil {
		t.Fatal(err)
	}
	state, err := sok.ReadInstalled(config)
	if err != nil {
		t.Fatal(err)
	}
	if state.Format != sok.InstalledFormat {
		t.Fatalf("format %d, want %d", state.Format, sok.InstalledFormat)
	}
	browser := state.Plugins["probe"]
	if browser.Version != "0.0.4" || browser.Path != "plugins/probe/0.0.4" || !browser.Enabled || browser.Previous != "0.0.3" {
		t.Fatalf("entry %+v", browser)
	}
	editor := state.Plugins["probe2"]
	if editor.Version != "0.0.2" || len(editor.Sidecars) != 1 || editor.Sidecars["@scope/sidecar-probe"] != "^0.0.4" {
		t.Fatalf("entry %+v", editor)
	}
	if state.Sidecars["@scope/sidecar-probe"].Version != "0.0.4" {
		t.Fatalf("sidecar %+v", state.Sidecars["@scope/sidecar-probe"])
	}
	data, err := os.ReadFile(filepath.Join(config, "plugins", "installed.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) == releasedFormat2 {
		t.Fatal("the file was not rewritten")
	}
}

// contract: install.migration.is-idempotent
func TestMigrateInstalledIsIdempotentAndLeavesACurrentFileAndAMissingFileUntouched(t *testing.T) {
	config := t.TempDir()
	writeInstalledRaw(t, config, releasedFormat2)
	if _, err := sok.MigrateInstalled(config); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(filepath.Join(config, "plugins", "installed.json"))
	if err != nil {
		t.Fatal(err)
	}
	applied, err := sok.MigrateInstalled(config)
	if err != nil {
		t.Fatal(err)
	}
	if applied != 0 {
		t.Fatal("a second run applied a migration")
	}
	second, err := os.ReadFile(filepath.Join(config, "plugins", "installed.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatalf("the bytes changed:\n%s\n%s", first, second)
	}
	empty := t.TempDir()
	if applied, err := sok.MigrateInstalled(empty); err != nil || applied != 0 {
		t.Fatalf("a missing file migrated: applied=%v err=%v", applied, err)
	}
	if _, err := os.Stat(filepath.Join(empty, "plugins", "installed.json")); !os.IsNotExist(err) {
		t.Fatalf("a missing file was created: %v", err)
	}
}

// contract: install.migration.refuses-forms-outside-the-chain
func TestMigrateInstalledRefusesAFormTheDefinitionsDoNotCover(t *testing.T) {
	for name, text := range map[string]string{
		"format 1":        `{"format": 1, "plugins": {}, "sidecars": {}}`,
		"above the chain": `{"format": 9, "plugins": {}, "sidecars": {}}`,
		"not JSON":        `{`,
	} {
		config := t.TempDir()
		writeInstalledRaw(t, config, text)
		_, err := sok.MigrateInstalled(config)
		if err == nil {
			t.Fatalf("%s was accepted", name)
		}
		if !strings.Contains(err.Error(), "plugins/installed.json") {
			t.Fatalf("%s: error %q does not name the file", name, err)
		}
	}
}

// contract: install.migration.chain-ends-at-the-current-format
func TestTheDefinitionChainEndsAtTheCurrentFormat(t *testing.T) {
	chains, err := sok.MigrationChainsForTest()
	if err != nil {
		t.Fatal(err)
	}
	chain, ok := chains["plugins/installed.json"]
	if !ok {
		t.Fatal("the definitions hold no chain for plugins/installed.json")
	}
	last := chain[len(chain)-1]
	if last.To != sok.InstalledFormat {
		t.Fatalf("the chain ends at format %d, the reader requires %d", last.To, sok.InstalledFormat)
	}
	for index, step := range chain {
		if index > 0 && step.From != chain[index-1].To {
			t.Fatalf("step %d starts at %d, the earlier step ends at %d", index, step.From, chain[index-1].To)
		}
	}
}

// contract: install.migration.settings-migrates-the-form-without-a-number
func TestMigrateSettingsAddsTheFormatNumberOfTheFormWithoutOne(t *testing.T) {
	config := t.TempDir()
	path := filepath.Join(config, "settings.json")
	if err := os.WriteFile(path, []byte(`{"theme":"dark"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if applied, err := sok.MigrateSettings(config); err != nil || applied != 1 {
		t.Fatalf("migrated %d err %v", applied, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"format":1`) || !strings.Contains(string(data), `"theme":"dark"`) {
		t.Fatalf("the migrated file %s", data)
	}
	if applied, err := sok.MigrateSettings(config); err != nil || applied != 0 {
		t.Fatalf("second run %d err %v", applied, err)
	}
}

// contract: install.migration.projects-wraps-the-bare-list
func TestMigrateProjectsWrapsTheBareListOfTheEarlierForm(t *testing.T) {
	config := t.TempDir()
	path := filepath.Join(config, "projects.json")
	if err := os.WriteFile(path, []byte(`[{"id":"prj-1","root":"/tmp/a","identity":"1:2"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	if applied, err := sok.MigrateProjects(config); err != nil || applied != 1 {
		t.Fatalf("migrated %d err %v", applied, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"format":1`) || !strings.Contains(string(data), `"id":"prj-1"`) {
		t.Fatalf("the migrated file %s", data)
	}
	if applied, err := sok.MigrateProjects(config); err != nil || applied != 0 {
		t.Fatalf("second run %d err %v", applied, err)
	}
}

// A migration happens once, at the install moment, so its record passes every gate: the default policy, which stores only
// errors, still stores it (docs/spec/logging.md#policy).
// contract: install.migration.record-passes-every-gate
func TestTheRecordOfAMigrationPassesTheDefaultPolicy(t *testing.T) {
	config := t.TempDir()
	writeInstalledRaw(t, config, releasedFormat2)
	log, err := sok.StartEventLog(optionsIn(filepath.Join(config, "logs"), "b1"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	sok.UseMigrationLog(log)
	_, err = sok.MigrateInstalled(config)
	sok.UseMigrationLog(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var records []map[string]any
	stored := storedLines(t, log.Path())
	for _, event := range stored {
		if event["event"] == "log.migrated" {
			records = append(records, event)
		}
	}
	if len(records) != 1 {
		t.Fatalf("the default policy stored %v, without one log.migrated", stored)
	}
	if records[0]["fields"].(map[string]any)["from"] != float64(2) {
		t.Fatalf("record %v", records[0])
	}
}

// A file format cannot be read when the definitions cannot be read: the error reaches the caller, so no format number is written
// for a file whose definitions are missing.
func TestAFormatWithoutReadableDefinitionsIsAnError(t *testing.T) {
	restore := sok.UseDefinitionsForTest(fstest.MapFS{})
	t.Cleanup(restore)
	if format, err := sok.ProjectsFormat(); err == nil {
		t.Fatalf("ProjectsFormat returned %d without an error for missing definitions", format)
	}
	if format, err := sok.SettingsFormat(); err == nil {
		t.Fatalf("SettingsFormat returned %d without an error for missing definitions", format)
	}
}

// A format member that is not an integer is refused with its text. Only a missing member is the form 0.
// contract: install.migration.refuses-forms-outside-the-chain
func TestMigrateProjectsRefusesAFormMemberThatIsNotAnInteger(t *testing.T) {
	for name, tc := range map[string]struct{ text, want string }{
		"a string":   {`{"format": "1", "projects": []}`, `format must be a number, found "1"`},
		"a fraction": {`{"format": 1.5, "projects": []}`, `format must be a number, found 1.5`},
	} {
		config := t.TempDir()
		if err := os.WriteFile(filepath.Join(config, "projects.json"), []byte(tc.text), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := sok.MigrateProjects(config)
		if err == nil {
			t.Fatalf("%s was accepted", name)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: error %q does not contain %q", name, err, tc.want)
		}
	}
}
