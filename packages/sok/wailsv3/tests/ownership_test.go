package tests

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// contract: cli.plugin.writing-commands-own-the-configuration
func TestAPluginCommandRefusesWhileAnotherProcessOwnsTheConfiguration(t *testing.T) {
	config := t.TempDir()
	if err := os.MkdirAll(filepath.Join(config, "plugins"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A live process (this test) owns the configuration directory through its lock.
	lock := filepath.Join(config, "process.lock")
	if err := os.WriteFile(lock, []byte(fmt.Sprintf("%d", os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := sok.RunPluginAction(config, "disable", "probe", "", "")
	if err == nil {
		t.Fatal("a write command ran while another process owned the configuration")
	}
	want := "configuration directory " + config + " is already owned by process " + fmt.Sprintf("%d", os.Getpid())
	if err.Error() != want {
		t.Fatalf("error %q, want %q", err.Error(), want)
	}
	// A read command still reads: the owner migrated the files, so a reader beside it reads as they are.
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}
	state, err := sok.ReadInstalled(config)
	if err != nil {
		t.Fatal(err)
	}
	if state.Format != sok.InstalledFormat {
		t.Fatalf("format %d", state.Format)
	}
}

// contract: cli.plugin.writing-commands-own-the-configuration
func TestAWritingCommandReleasesTheConfigurationWhenItEnds(t *testing.T) {
	config := t.TempDir()
	writeInstalledRaw(t, config, releasedFormat2)
	// The disable action reads the name of the plugin from its recorded folder.
	plugin := filepath.Join(config, "plugins", "probe", "0.0.4")
	if err := os.MkdirAll(plugin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plugin, "package.json"), []byte(`{"name":"@scope/plugin-probe"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// The change walks every installed plugin folder.
	second := filepath.Join(config, "plugins", "probe2", "0.0.2")
	if err := os.MkdirAll(second, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(second, "package.json"), []byte(`{"name":"@scope/plugin-probe2"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(second, "plugin.json"), []byte(`{"id":"probe2"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := sok.RunPluginAction(config, "disable", "probe", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(config, "process.lock")); !os.IsNotExist(err) {
		t.Fatalf("the lock stayed: %v", err)
	}
	// A second command runs at once: the first released the configuration when it ended.
	if _, err := sok.RunPluginAction(config, "disable", "probe", "", ""); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(readText(t, filepath.Join(config, "plugins", "installed.json")), "package") {
		t.Fatal("the second command did not see the migrated file")
	}
}
