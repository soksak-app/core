package tests

// Checks the plugin categories of plugin.json and the settings declaration of type plugin (docs/spec/plugins.md#plugin-categories),
// and the operations that keep a category served for the plugins that require it.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/src"
	"github.com/soksak-app/core/packages/sok/go/tests/support"
)

// categoryPlugin is one version of a plugin of the category registry. categories and requires are written into plugin.json
// when they are not nil, so a nil list is absent and an empty list is [].
type categoryPlugin struct {
	id, version          string
	categories, requires []string
}

// surfaceManifest is a plugin.json with a view surface, which the members categories and requires need, plus extra members.
func surfaceManifest(extra map[string]any) map[string]any {
	manifest := map[string]any{"id": "probe", "name": "Probe", "description": "Sample.",
		"surface": map[string]any{"composition": map[string]any{"kind": "view", "page": "ui/page.html"}},
		"mark":    "P", "icon": "<svg></svg>"}
	for key, value := range extra {
		manifest[key] = value
	}
	return manifest
}

// contributesManifest is a plugin.json with a contributes member and no surface, which a categories member refuses.
func contributesManifest(extra map[string]any) map[string]any {
	manifest := map[string]any{"id": "probe", "name": "Probe", "description": "Sample.",
		"contributes": map[string]any{"lib.point": []any{}}}
	for key, value := range extra {
		manifest[key] = value
	}
	return manifest
}

// settingManifest is a surface manifest that declares the setting key with the declaration.
func settingManifest(declaration map[string]any) map[string]any {
	return surfaceManifest(map[string]any{"settings": map[string]any{"key": declaration}})
}

func TestPluginCategoriesMatchTheCaseFile(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "docs", "spec", "cases", "plugin-categories.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Categories []string `json:"categories"`
	}
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Categories) == 0 {
		t.Fatal("the plugin category case file holds no category")
	}
	if !slices.Equal(sok.PluginCategories(), table.Categories) {
		t.Fatalf("PluginCategories %v, the case file %v", sok.PluginCategories(), table.Categories)
	}
}

func TestValidateManifestAcceptsThePluginCategoryMembers(t *testing.T) {
	for name, manifest := range map[string]map[string]any{
		"categories": surfaceManifest(map[string]any{"categories": []any{"terminal"}}),
		"requires":   surfaceManifest(map[string]any{"requires": []any{"terminal"}}),
		"empty":      surfaceManifest(map[string]any{"categories": []any{}, "requires": []any{}}),
	} {
		if err := sok.ValidateManifest(manifest); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestValidateManifestRefusesTheInvalidPluginCategoryMembers(t *testing.T) {
	for _, c := range []struct {
		name     string
		manifest map[string]any
		want     string
	}{
		{"categories is not a list", surfaceManifest(map[string]any{"categories": "terminal"}),
			"plugin probe: categories must be a list of plugin categories"},
		{"categories names no category of core", surfaceManifest(map[string]any{"categories": []any{"shell"}}),
			"plugin probe: categories category shell is not a plugin category of core"},
		{"categories names a non-text category", surfaceManifest(map[string]any{"categories": []any{json.Number("1")}}),
			"plugin probe: categories category 1 is not a plugin category of core"},
		{"categories repeats", surfaceManifest(map[string]any{"categories": []any{"terminal", "terminal"}}),
			"plugin probe: categories category terminal repeats"},
		{"categories needs a surface", contributesManifest(map[string]any{"categories": []any{"terminal"}}),
			"plugin probe: categories require a surface"},
		{"requires is not a list", surfaceManifest(map[string]any{"requires": "terminal"}),
			"plugin probe: requires must be a list of plugin categories"},
		{"requires names no category of core", surfaceManifest(map[string]any{"requires": []any{"shell"}}),
			"plugin probe: requires category shell is not a plugin category of core"},
		{"requires repeats", surfaceManifest(map[string]any{"requires": []any{"terminal", "terminal"}}),
			"plugin probe: requires category terminal repeats"},
		{"requires names a category of categories", surfaceManifest(map[string]any{"categories": []any{"terminal"}, "requires": []any{"terminal"}}),
			"plugin probe: requires category terminal is in categories"},
		{"requires needs a surface or sections", contributesManifest(map[string]any{"requires": []any{"terminal"}}),
			"plugin probe: requires require a surface or sections"},
	} {
		if err := sok.ValidateManifest(c.manifest); err == nil || err.Error() != c.want {
			t.Fatalf("%s: error %v, want %q", c.name, err, c.want)
		}
	}
}

func TestValidateManifestAcceptsThePluginSettingDeclaration(t *testing.T) {
	manifest := settingManifest(map[string]any{"type": "plugin", "category": "terminal", "label": "Shell", "description": "Choose."})
	if err := sok.ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}
}

func TestValidateManifestRefusesTheInvalidPluginSettingDeclaration(t *testing.T) {
	for _, c := range []struct {
		name        string
		declaration map[string]any
		want        string
	}{
		{"default is not part of a plugin setting", map[string]any{"type": "plugin", "category": "terminal", "default": "shell", "label": "Shell", "description": "Choose."},
			"plugin probe.key: unknown field default"},
		{"category names no category of core", map[string]any{"type": "plugin", "category": "shell", "label": "Shell", "description": "Choose."},
			"plugin probe.key: category shell is not a plugin category of core"},
		{"category is absent", map[string]any{"type": "plugin", "label": "Shell", "description": "Choose."},
			"plugin probe.key: category undefined is not a plugin category of core"},
	} {
		if err := sok.ValidateManifest(settingManifest(c.declaration)); err == nil || err.Error() != c.want {
			t.Fatalf("%s: error %v, want %q", c.name, err, c.want)
		}
	}
}

// categoryRegistry writes index.json of a registry folder with a packed release of each plugin version. Each plugin has a
// view surface, and its plugin.json holds the categories and requires members of the version that are not nil.
func categoryRegistry(t *testing.T, plugins ...categoryPlugin) string {
	t.Helper()
	type entry = map[string]any
	releases := t.TempDir()
	entries := map[string]entry{}
	var ids []string
	for _, item := range plugins {
		manifest := entry{"id": item.id, "name": "Probe", "description": "Sample.",
			"surface": entry{"composition": entry{"kind": "view", "page": "ui/page.html"}}, "mark": "P", "icon": "<svg></svg>"}
		if item.categories != nil {
			manifest["categories"] = item.categories
		}
		if item.requires != nil {
			manifest["requires"] = item.requires
		}
		dir := t.TempDir()
		writeTree(t, dir, map[string]string{
			"package.json": `{"name": "@scope/plugin-` + item.id + `", "version": "` + item.version + `", "engines": {"soksak": "^0.0.2"},
				"files": ["plugin.json", "ui/page.html"]}`,
			"plugin.json":  jsonText(t, manifest),
			"ui/page.html": "<p>page</p>",
		})
		result := support.PackRelease(t, dir, releases)
		if entries[item.id] == nil {
			ids = append(ids, item.id)
			entries[item.id] = entry{"id": item.id, "package": "@scope/plugin-" + item.id, "name": item.id, "description": "검사용 plugin.",
				"license": "MIT", "repository": "https://example.invalid/" + item.id, "versions": []any{}}
		}
		entries[item.id]["versions"] = append(entries[item.id]["versions"].([]any), entry{"version": item.version,
			"release": entry{"url": "file://" + result["release"], "sha256": result["sha256"]}, "engines": entry{"soksak": "^0.0.2"},
			"sidecars": entry{}, "plugins": entry{}})
	}
	list := []any{}
	for _, id := range ids {
		list = append(list, entries[id])
	}
	registry := t.TempDir()
	writeTree(t, registry, map[string]string{"index.json": jsonText(t, entry{"format": 2, "plugins": list, "sidecars": []any{},
		"packs": []any{}, "revoked": entry{"plugins": []any{}, "sidecars": []any{}}})})
	return registry
}

var (
	terminalShell = categoryPlugin{"shell", "1.0.0", []string{"terminal"}, nil}
	terminalAlpha = categoryPlugin{"alpha", "1.0.0", nil, []string{"terminal"}}
	terminalBeta  = categoryPlugin{"beta", "1.0.0", nil, []string{"terminal"}}
)

func TestPluginInstallRefusesARequiredCategoryWithoutAPlugin(t *testing.T) {
	config := t.TempDir()
	useRegistry(t, config, categoryRegistry(t, terminalShell, terminalAlpha))
	code, _, stderr := run("plugin", "install", "alpha", "--config-dir", config)
	if code != 1 || stderr != "sok: plugin alpha requires a terminal plugin, and no installed and enabled plugin is one\n" {
		t.Fatalf("install alpha: code %d stderr %q", code, stderr)
	}
	if folders := pluginFolders(t, config); folders != "registry.json" {
		t.Fatalf("a refused install changed the installation: %s", folders)
	}
	succeeds(t, "plugin", "install", "shell", "--config-dir", config)
	succeeds(t, "plugin", "install", "alpha", "--config-dir", config)
}

func TestPluginInstallRefusesARequiredCategoryWhoseProviderIsDisabled(t *testing.T) {
	config := t.TempDir()
	useRegistry(t, config, categoryRegistry(t, terminalShell, terminalAlpha))
	succeeds(t, "plugin", "install", "shell", "--config-dir", config)
	succeeds(t, "plugin", "disable", "shell", "--config-dir", config)
	before := readText(t, filepath.Join(config, "plugins/installed.json"))
	code, _, stderr := run("plugin", "install", "alpha", "--config-dir", config)
	if code != 1 || stderr != "sok: plugin alpha requires a terminal plugin, and no installed and enabled plugin is one\n" {
		t.Fatalf("install alpha: code %d stderr %q", code, stderr)
	}
	if readText(t, filepath.Join(config, "plugins/installed.json")) != before {
		t.Fatal("a refused install changed installed.json")
	}
}

func TestPluginEnableRefusesARequiredCategoryWithoutAPlugin(t *testing.T) {
	config := t.TempDir()
	useRegistry(t, config, categoryRegistry(t, terminalShell, terminalAlpha))
	succeeds(t, "plugin", "install", "shell", "--config-dir", config)
	succeeds(t, "plugin", "install", "alpha", "--config-dir", config)
	succeeds(t, "plugin", "disable", "alpha", "--config-dir", config)
	succeeds(t, "plugin", "disable", "shell", "--config-dir", config)
	before := readText(t, filepath.Join(config, "plugins/installed.json"))
	code, _, stderr := run("plugin", "enable", "alpha", "--config-dir", config)
	if code != 1 || stderr != "sok: plugin alpha requires a terminal plugin, and no installed and enabled plugin is one\n" {
		t.Fatalf("enable alpha: code %d stderr %q", code, stderr)
	}
	if readText(t, filepath.Join(config, "plugins/installed.json")) != before {
		t.Fatal("a refused enable changed installed.json")
	}
}

// and name the requirers in the order of their ids.
func TestPluginDisableAndRemoveRefuseTheLastPluginOfARequiredCategory(t *testing.T) {
	config := t.TempDir()
	useRegistry(t, config, categoryRegistry(t, terminalShell, terminalAlpha, terminalBeta))
	for _, id := range []string{"shell", "alpha", "beta"} {
		succeeds(t, "plugin", "install", id, "--config-dir", config)
	}
	before := readText(t, filepath.Join(config, "plugins/installed.json"))
	for _, action := range []string{"disable", "remove"} {
		code, _, stderr := run("plugin", action, "shell", "--config-dir", config)
		if code != 1 || stderr != "sok: plugin shell is the last terminal plugin, which alpha, beta requires\n" {
			t.Fatalf("%s shell: code %d stderr %q", action, code, stderr)
		}
		if readText(t, filepath.Join(config, "plugins/installed.json")) != before {
			t.Fatalf("a refused %s changed installed.json", action)
		}
	}
	// A disabled requirer does not require the category.
	succeeds(t, "plugin", "disable", "alpha", "--config-dir", config)
	code, _, stderr := run("plugin", "disable", "shell", "--config-dir", config)
	if code != 1 || stderr != "sok: plugin shell is the last terminal plugin, which beta requires\n" {
		t.Fatalf("disable shell with beta only: code %d stderr %q", code, stderr)
	}
	// A second enabled plugin of the category serves it, so the first one may be disabled.
	succeeds(t, "plugin", "disable", "beta", "--config-dir", config)
	succeeds(t, "plugin", "disable", "shell", "--config-dir", config)
	if installed := installedOf(t, config); installed.Plugins["shell"].Enabled || installed.Plugins["beta"].Enabled {
		t.Fatalf("installed %+v", installed)
	}
}

func TestPluginDisableAllowsTheLastPluginOfACategoryWithoutRequirers(t *testing.T) {
	config := t.TempDir()
	useRegistry(t, config, categoryRegistry(t, terminalShell, terminalAlpha))
	succeeds(t, "plugin", "install", "shell", "--config-dir", config)
	succeeds(t, "plugin", "install", "alpha", "--config-dir", config)
	succeeds(t, "plugin", "disable", "alpha", "--config-dir", config)
	succeeds(t, "plugin", "disable", "shell", "--config-dir", config)
	if installed := installedOf(t, config); installed.Plugins["shell"].Enabled {
		t.Fatalf("shell is enabled: %+v", installed)
	}
}

func TestPluginUpdateRefusesADropOfARequiredCategory(t *testing.T) {
	config := t.TempDir()
	shellWithoutCategory := categoryPlugin{"shell", "2.0.0", []string{}, nil}
	useRegistry(t, config, categoryRegistry(t, terminalShell, terminalAlpha))
	succeeds(t, "plugin", "install", "shell", "--config-dir", config)
	succeeds(t, "plugin", "install", "alpha", "--config-dir", config)
	useRegistry(t, config, categoryRegistry(t, terminalShell, terminalAlpha, shellWithoutCategory))
	before := readText(t, filepath.Join(config, "plugins/installed.json"))
	code, _, stderr := run("plugin", "update", "shell", "--config-dir", config)
	if code != 1 || stderr != "sok: plugin shell is the last terminal plugin, which alpha requires\n" {
		t.Fatalf("update shell: code %d stderr %q", code, stderr)
	}
	if readText(t, filepath.Join(config, "plugins/installed.json")) != before {
		t.Fatal("a refused update changed installed.json")
	}
	// A version that keeps the category is updated.
	useRegistry(t, config, categoryRegistry(t, terminalShell, terminalAlpha, categoryPlugin{"shell", "2.0.0", []string{"terminal"}, nil}))
	succeeds(t, "plugin", "update", "shell", "--config-dir", config)
	if version := installedOf(t, config).Plugins["shell"].Version; version != "2.0.0" {
		t.Fatalf("shell version %s", version)
	}
}

func TestPluginUpdateRefusesANewRequirementWithoutAPlugin(t *testing.T) {
	config := t.TempDir()
	extV1 := categoryPlugin{"ext", "1.0.0", nil, nil}
	extV2 := categoryPlugin{"ext", "2.0.0", nil, []string{"terminal"}}
	useRegistry(t, config, categoryRegistry(t, terminalShell, extV1))
	succeeds(t, "plugin", "install", "ext", "--config-dir", config)
	useRegistry(t, config, categoryRegistry(t, terminalShell, extV1, extV2))
	before := readText(t, filepath.Join(config, "plugins/installed.json"))
	code, _, stderr := run("plugin", "update", "ext", "--config-dir", config)
	if code != 1 || stderr != "sok: plugin ext requires a terminal plugin, and no installed and enabled plugin is one\n" {
		t.Fatalf("update ext: code %d stderr %q", code, stderr)
	}
	if readText(t, filepath.Join(config, "plugins/installed.json")) != before {
		t.Fatal("a refused update changed installed.json")
	}
	succeeds(t, "plugin", "install", "shell", "--config-dir", config)
	succeeds(t, "plugin", "update", "ext", "--config-dir", config)
	if version := installedOf(t, config).Plugins["ext"].Version; version != "2.0.0" {
		t.Fatalf("ext version %s", version)
	}
}
