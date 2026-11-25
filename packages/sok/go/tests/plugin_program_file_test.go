package tests

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/tests/support"
)

// installProgramProbe packages a view plugin whose programs.run names plugin:bin/tool, with the files of the release, and
// installs it. A file name that ends in `*` is written as an executable file. It returns the exit code, the standard error and
// whether the installation state was written, and the configuration folder.
func installProgramProbe(t *testing.T, files []string, executable bool) (int, string, bool, string) {
	t.Helper()
	manifest := map[string]any{"id": "probe", "name": "Probe", "description": "Sample.",
		"surface": map[string]any{"composition": map[string]any{"kind": "view", "page": "ui/page.html"}},
		"mark":    "P", "icon": "<svg></svg>",
		"programs": map[string]any{"run": map[string]any{"program": "plugin:bin/tool"}}}
	dir := t.TempDir()
	contents := map[string]string{
		"package.json": jsonText(t, map[string]any{"name": "@scope/plugin-probe", "version": "0.2.0",
			"engines": map[string]any{"soksak": "^0.0.2"}, "files": append([]string{"plugin.json", "ui/page.html"}, files...)}),
		"plugin.json":  jsonText(t, manifest),
		"ui/page.html": "",
	}
	writeTree(t, dir, contents)
	for _, file := range files {
		name := file
		writeTree(t, dir, map[string]string{name: ""})
		mode := 0o644
		if executable {
			mode = 0o755
		}
		if err := os.Chmod(filepath.Join(dir, filepath.FromSlash(name)), os.FileMode(mode)); err != nil {
			t.Fatal(err)
		}
	}
	release := support.PackRelease(t, dir, t.TempDir())
	config := t.TempDir()
	runJSON(t, "registry", "use", indexForRelease(t, release["release"], release["sha256"]), "--config-dir", config)
	code, _, stderr := run("plugin", "install", "probe", "--config-dir", config)
	return code, stderr, exists(filepath.Join(config, "plugins", "installed.json")), config
}

// contract: install.plugin-program-file
func TestPluginInstallChecksTheProgramFileOfThePlugin(t *testing.T) {
	code, stderr, installed, _ := installProgramProbe(t, []string{"bin/tool"}, true)
	if code != 0 || !installed {
		t.Fatalf("an executable program file: code %d stderr %q installed %v", code, stderr, installed)
	}
	code, stderr, installed, _ = installProgramProbe(t, []string{"bin/tool"}, false)
	want := "sok: plugin probe: programs.run program plugin:bin/tool is not a regular executable file\n"
	if code != 1 || stderr != want || installed {
		t.Fatalf("a program file without an execute bit: code %d stderr %q installed %v, want %q", code, stderr, installed, want)
	}
	code, stderr, installed, _ = installProgramProbe(t, nil, true)
	want = "sok: plugin probe: programs.run program plugin:bin/tool is not found\n"
	if code != 1 || stderr != want || installed {
		t.Fatalf("a missing program file: code %d stderr %q installed %v, want %q", code, stderr, installed, want)
	}
}

// A refused installation removes the version folder that it extracted, so the next installation of the same version extracts the
// release again instead of reading the refused files (docs/spec/installation.md#installation-layout).
func TestARefusedPluginInstallLeavesNoVersionFolder(t *testing.T) {
	code, stderr, installed, config := installProgramProbe(t, []string{"bin/tool"}, false)
	if code != 1 || installed {
		t.Fatalf("a program file without an execute bit: code %d stderr %q installed %v", code, stderr, installed)
	}
	if folder := filepath.Join(config, "plugins", "probe", "0.2.0"); exists(folder) {
		t.Fatalf("the refused installation left %s", folder)
	}
}
