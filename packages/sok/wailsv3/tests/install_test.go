package tests

// 설치 형식(docs/spec/installation.md)의 검사와 version 선택을 검사한다.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func archive(name string) string {
	return `{"url": "file:///releases/` + name + `", "sha256": "` + sha + `"}`
}

func pluginJSON() string {
	return `{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.", "license": "MIT",
		"repository": "https://example.invalid/probe", "versions": [
		{"version": "0.1.0", "package": ` + archive("probe-0.1.0.tgz") + `, "engines": {"soksak": "^0.0.1"}, "sidecars": {"@scope/sidecar-worker": "^0.1.0"}},
		{"version": "0.2.0", "package": ` + archive("probe-0.2.0.tgz") + `, "engines": {"soksak": "^0.0.2"}, "sidecars": {"@scope/sidecar-worker": "^0.1.0"}},
		{"version": "0.3.0", "package": ` + archive("probe-0.3.0.tgz") + `, "engines": {"soksak": "^0.0.2"}, "sidecars": {"@scope/sidecar-worker": "^0.1.0"}}]}`
}

func sidecarJSON() string {
	return `{"name": "@scope/sidecar-worker", "repository": "https://example.invalid/worker", "versions": [
		{"version": "0.1.0", "protocol": 1, "assets": {"darwin-arm64": ` + archive("a") + `, "darwin-x64": ` + archive("b") + `}},
		{"version": "0.1.1", "protocol": 1, "assets": {"darwin-arm64": ` + archive("c") + `}}]}`
}

func indexJSON() string {
	return `{"format": 1, "plugins": [` + pluginJSON() + `], "sidecars": [` + sidecarJSON() + `],
		"packs": [{"name": "starter", "description": "처음 설치하는 plugin.", "plugins": ["probe"]}],
		"revoked": {"plugins": [{"id": "probe", "version": "0.3.0", "reason": "breaks saved spaces"}], "sidecars": []}}`
}

func decode(t *testing.T, text string) any {
	t.Helper()
	value, err := sok.DecodeJSON([]byte(text))
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	return value
}

// at 은 fixture 안의 객체나 배열 원소를 경로로 찾는다.
func at(value any, path ...any) any {
	for _, step := range path {
		switch key := step.(type) {
		case string:
			value = value.(map[string]any)[key]
		case int:
			value = value.([]any)[key]
		}
	}
	return value
}

func rejects(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("error %v, want %q", err, want)
	}
}

// contract: install.version.ranges-and-order
func TestVersionRangesAcceptExactCaretTildeAndBoundedForms(t *testing.T) {
	for text, want := range map[string][2]string{
		"0.0.2": {"0.0.2", "0.0.3"}, "^0.0.2": {"0.0.2", "0.0.3"}, "^0.2.3": {"0.2.3", "0.3.0"},
		"^1.2.3": {"1.2.3", "2.0.0"}, "~1.2.3": {"1.2.3", "1.3.0"}, ">=0.0.2 <0.1.0": {"0.0.2", "0.1.0"},
	} {
		r, err := sok.ParseRange(text)
		if err != nil || r.Min.String() != want[0] || r.Below.String() != want[1] {
			t.Fatalf("%s: %v %v", text, r, err)
		}
	}
	if !sok.Satisfies("0.0.9", ">=0.0.2 <0.1.0") || sok.Satisfies("0.1.0", ">=0.0.2 <0.1.0") {
		t.Fatal("bounded range bounds")
	}
	a, _ := sok.ParseVersion("0.10.0")
	b, _ := sok.ParseVersion("0.9.9")
	if a.Compare(b) <= 0 {
		t.Fatal("versions compare by number, not text")
	}
	for _, bad := range []string{"*", "latest", "0.0", "01.0.0", ">=0.1.0 <0.1.0", "^0.0.2-beta", "4294967296.0.0"} {
		if _, err := sok.ParseRange(bad); err == nil || !strings.Contains(err.Error(), "invalid version") {
			t.Fatalf("%s: %v", bad, err)
		}
	}
}

// contract: install.package.fields-and-manifest
func TestPluginPackageDeclaresVersionCoreRangeSidecarRangesAndFiles(t *testing.T) {
	text := `{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"},
		"soksak": {"sidecars": {"@scope/sidecar-worker": "^0.1.0"}}, "files": ["plugin.json", "ui"], "private": true}`
	pkg := decode(t, text)
	if err := sok.ValidatePluginPackage(pkg); err != nil {
		t.Fatal(err)
	}
	manifest := decode(t, `{"sidecars": ["@scope/sidecar-worker"]}`).(map[string]any)
	if err := sok.CheckPackageManifest(pkg.(map[string]any), manifest); err != nil {
		t.Fatal(err)
	}
	rejects(t, sok.CheckPackageManifest(pkg.(map[string]any), map[string]any{}),
		`@scope/plugin-probe: plugin.json sidecars [] differ from package.json soksak.sidecars ["@scope/sidecar-worker"]`)
	for change, want := range map[string]string{
		`"engines": {}`:                          "package.json engines.soksak: invalid version range null",
		`"files": ["ui"]`:                        "package.json files: plugin.json is not listed",
		`"files": ["plugin.json", "../ui"]`:      "package.json files: expected paths inside the package",
		`"soksak": {"sidecars": {}, "extra": 1}`: "package.json soksak: unknown field extra",
		`"version": "0.2"`:                       `package.json version: invalid version "0.2": expected x.y.z`,
		`"name": "Plugin"`:                       "package.json name: expected a package name",
	} {
		field := change[:strings.Index(change, ":")]
		changed := decode(t, text).(map[string]any)
		changed[strings.Trim(field, `"`)] = at(decode(t, "{"+change+"}"), strings.Trim(field, `"`))
		rejects(t, sok.ValidatePluginPackage(changed), want)
	}
}

// contract: install.registry.entries
func TestRegistryEntriesRejectUnknownFieldsBadArchivesAndRepeatedVersions(t *testing.T) {
	if err := sok.ValidateRegistryPlugin(decode(t, pluginJSON())); err != nil {
		t.Fatal(err)
	}
	if err := sok.ValidateRegistrySidecar(decode(t, sidecarJSON())); err != nil {
		t.Fatal(err)
	}
	extra := decode(t, pluginJSON())
	extra.(map[string]any)["homepage"] = "x"
	rejects(t, sok.ValidateRegistryPlugin(extra), "registry plugin probe: unknown field homepage")
	for url, want := range map[string]string{
		"ftp://example.invalid/probe.tgz": "ftp://example.invalid/probe.tgz: the URL must be https: or an absolute file: URL",
		"https:probe.tgz":                 "https:probe.tgz: the URL must be https: or an absolute file: URL",
		"file:releases/probe.tgz":         "file:releases/probe.tgz: url must be an absolute file: URL",
		"file:///releases/probe.tgz?x=1":  "file:///releases/probe.tgz?x=1: url must be an absolute file: URL without a query or fragment",
		"file:///releases/%zz.tgz":        "file:///releases/%zz.tgz: url has an invalid escape",
	} {
		changed := decode(t, pluginJSON())
		at(changed, "versions", 0, "package").(map[string]any)["url"] = url
		rejects(t, sok.ValidateRegistryPlugin(changed), "registry plugin probe 0.1.0 package: "+want)
	}
	if path, err := sok.FilePath("file:///Users/a%20b/probe.tgz"); err != nil || path != "/Users/a b/probe.tgz" {
		t.Fatalf("escaped path %q %v", path, err)
	}
	hash := decode(t, pluginJSON())
	at(hash, "versions", 0, "package").(map[string]any)["sha256"] = "ABC"
	rejects(t, sok.ValidateRegistryPlugin(hash), "sha256 must be 64 lowercase hexadecimal digits")
	twice := decode(t, pluginJSON())
	twice.(map[string]any)["versions"] = append(at(twice, "versions").([]any), at(twice, "versions", 0))
	rejects(t, sok.ValidateRegistryPlugin(twice), "registry plugin probe: version 0.1.0 appears twice")
	long := decode(t, pluginJSON())
	long.(map[string]any)["description"] = strings.Repeat("가", 201)
	rejects(t, sok.ValidateRegistryPlugin(long), "description must be 1 to 200 characters")
	long.(map[string]any)["description"] = strings.Repeat("가", 200)
	if err := sok.ValidateRegistryPlugin(long); err != nil {
		t.Fatalf("200 characters: %v", err)
	}
	platform := decode(t, sidecarJSON())
	at(platform, "versions", 0, "assets").(map[string]any)["darwin-ppc"] = decode(t, archive("x"))
	rejects(t, sok.ValidateRegistrySidecar(platform), "registry sidecar @scope/sidecar-worker 0.1.0: unknown platform darwin-ppc")
	protocol := decode(t, sidecarJSON())
	at(protocol, "versions", 0).(map[string]any)["protocol"] = json.Number("1.0")
	rejects(t, sok.ValidateRegistrySidecar(protocol), "registry sidecar @scope/sidecar-worker 0.1.0: protocol must be 1")
	rejects(t, sok.ValidateRegistryPack(decode(t, `{"name": "starter", "description": "x", "plugins": []}`)),
		"registry pack starter: plugins must be plugin ids")
	rejects(t, sok.ValidateRevoked(decode(t, `{"plugins": [{"id": "probe", "version": "0.1.0"}], "sidecars": []}`)),
		"registry revoked plugins probe: reason is required")
}

// contract: install.registry.index-cross-checks
func TestRegistryIndexChecksNamesPacksSidecarRangesAndRevokedVersions(t *testing.T) {
	if _, err := sok.ValidateRegistryIndex(decode(t, indexJSON())); err != nil {
		t.Fatal(err)
	}
	pack := decode(t, indexJSON())
	at(pack, "packs", 0).(map[string]any)["plugins"] = append(at(pack, "packs", 0, "plugins").([]any), "missing")
	_, err := sok.ValidateRegistryIndex(pack)
	rejects(t, err, "registry index: pack starter names unknown plugin missing")
	rng := decode(t, indexJSON())
	at(rng, "plugins", 0, "versions", 0, "sidecars").(map[string]any)["@scope/sidecar-worker"] = "^0.2.0"
	_, err = sok.ValidateRegistryIndex(rng)
	rejects(t, err, "registry index: plugin probe 0.1.0 needs @scope/sidecar-worker ^0.2.0, which no version satisfies")
	unknown := decode(t, indexJSON())
	at(unknown, "plugins", 0, "versions", 0).(map[string]any)["sidecars"] = map[string]any{"@scope/sidecar-gone": "^0.1.0"}
	_, err = sok.ValidateRegistryIndex(unknown)
	rejects(t, err, "registry index: plugin probe 0.1.0 needs unknown sidecar @scope/sidecar-gone")
	revoked := decode(t, indexJSON())
	at(revoked, "revoked", "plugins", 0).(map[string]any)["version"] = "9.9.9"
	_, err = sok.ValidateRegistryIndex(revoked)
	rejects(t, err, "registry index: revoked plugin probe 9.9.9 is not listed")
	duplicate := decode(t, indexJSON())
	other := decode(t, pluginJSON())
	other.(map[string]any)["id"] = "other"
	duplicate.(map[string]any)["plugins"] = append(at(duplicate, "plugins").([]any), other)
	_, err = sok.ValidateRegistryIndex(duplicate)
	rejects(t, err, "registry index: package @scope/plugin-probe appears twice")
	format := decode(t, indexJSON())
	format.(map[string]any)["format"] = json.Number("2")
	_, err = sok.ValidateRegistryIndex(format)
	rejects(t, err, "registry index: format must be 1")
}

func versions(selection *sok.Selection) []string {
	out := []string{}
	for _, item := range selection.Sidecars {
		out = append(out, item.Name+" "+item.Version)
	}
	return out
}

func emptyInstalled() *sok.InstalledState {
	return &sok.InstalledState{Format: 1, Plugins: map[string]sok.InstalledPlugin{}, Sidecars: map[string]sok.InstalledSidecar{}}
}

// contract: install.select.newest-usable
func TestInstallationResolvesNewestUsablePluginAndSidecarVersions(t *testing.T) {
	index, err := sok.ValidateRegistryIndex(decode(t, indexJSON()))
	if err != nil {
		t.Fatal(err)
	}
	// 0.3.0 은 revoked 이므로 0.2.0 을 고르고, sidecar 는 darwin-arm64 asset 이 있는 가장 새 0.1.1 을 고른다.
	arm, err := sok.ResolveInstall(index, "probe", "0.0.2", "darwin-arm64", emptyInstalled())
	if err != nil || arm.Version.Version != "0.2.0" || strings.Join(versions(arm), ",") != "@scope/sidecar-worker 0.1.1" {
		t.Fatalf("darwin-arm64: %v %v", arm, err)
	}
	if arm.Sidecars[0].Asset.URL != "file:///releases/c" {
		t.Fatalf("asset %v", arm.Sidecars[0].Asset)
	}
	// darwin-x64 asset 은 0.1.0 에만 있다.
	x64, err := sok.ResolveInstall(index, "probe", "0.0.2", "darwin-x64", emptyInstalled())
	if err != nil || strings.Join(versions(x64), ",") != "@scope/sidecar-worker 0.1.0" {
		t.Fatalf("darwin-x64: %v %v", x64, err)
	}
	old, err := sok.ResolveInstall(index, "probe", "0.0.1", "darwin-arm64", emptyInstalled())
	if err != nil || old.Version.Version != "0.1.0" {
		t.Fatalf("core 0.0.1: %v %v", old, err)
	}
	_, err = sok.ResolveInstall(index, "probe", "0.1.0", "darwin-arm64", emptyInstalled())
	rejects(t, err, "plugin probe has no version for core 0.1.0")
	_, err = sok.ResolveInstall(index, "probe", "0.0.2", "linux-x64", emptyInstalled())
	rejects(t, err, "sidecar @scope/sidecar-worker has no version for linux-x64 that satisfies every installed plugin: probe 0.2.0 needs ^0.1.0")
	_, err = sok.ResolveInstall(index, "gone", "0.0.2", "darwin-arm64", emptyInstalled())
	rejects(t, err, "plugin gone is not in the registry")
}

// contract: install.select.shared-sidecar
func TestInstallationKeepsOneSidecarVersionThatSatisfiesEveryInstalledPlugin(t *testing.T) {
	index, err := sok.ValidateRegistryIndex(decode(t, indexJSON()))
	if err != nil {
		t.Fatal(err)
	}
	other := func(rng, version string) *sok.InstalledState {
		state := emptyInstalled()
		state.Plugins["other"] = sok.InstalledPlugin{Package: "plugin-other", Version: "1.0.0", Path: "/config/plugins/other/1.0.0", Enabled: true, Sidecars: map[string]string{"@scope/sidecar-worker": rng}}
		state.Sidecars["@scope/sidecar-worker"] = sok.InstalledSidecar{Version: version, Path: "/config/sidecars/scope-sidecar-worker/" + version + "/darwin-arm64"}
		return state
	}
	// 다른 plugin 이 0.1.0 을 쓰고 있고 그 version 이 두 범위를 채우므로 더 새 0.1.1 대신 0.1.0 을 그대로 둔다.
	kept, err := sok.ResolveInstall(index, "probe", "0.0.2", "darwin-arm64", other("^0.1.0", "0.1.0"))
	if err != nil || strings.Join(versions(kept), ",") != "@scope/sidecar-worker 0.1.0" {
		t.Fatalf("kept: %v %v", kept, err)
	}
	// 다른 plugin 의 범위가 0.1.0 만 허용하면 두 범위를 채우는 0.1.0 을 고른다.
	exact, err := sok.ResolveInstall(index, "probe", "0.0.2", "darwin-arm64", other("0.1.0", "0.1.0"))
	if err != nil || strings.Join(versions(exact), ",") != "@scope/sidecar-worker 0.1.0" {
		t.Fatalf("exact: %v %v", exact, err)
	}
	// 범위를 함께 채우는 version 이 없으면 각 plugin 과 범위를 밝혀 실패한다.
	_, err = sok.ResolveInstall(index, "probe", "0.0.2", "darwin-arm64", other("^0.2.0", "0.2.0"))
	rejects(t, err, "sidecar @scope/sidecar-worker has no version for darwin-arm64 that satisfies every installed plugin: probe 0.2.0 needs ^0.1.0, other 1.0.0 needs ^0.2.0")
	// 같은 plugin 의 이전 version 범위는 새 version 을 막지 않는다.
	self := emptyInstalled()
	self.Plugins["probe"] = sok.InstalledPlugin{Package: "@scope/plugin-probe", Version: "0.1.0", Path: "/config/plugins/probe/0.1.0", Enabled: true, Sidecars: map[string]string{"@scope/sidecar-worker": "0.1.0"}}
	self.Sidecars["@scope/sidecar-worker"] = sok.InstalledSidecar{Version: "0.1.0", Path: "/config/sidecars/scope-sidecar-worker/0.1.0/darwin-arm64"}
	again, err := sok.ResolveInstall(index, "probe", "0.0.2", "darwin-arm64", self)
	if err != nil || strings.Join(versions(again), ",") != "@scope/sidecar-worker 0.1.0" {
		t.Fatalf("self: %v %v", again, err)
	}
}

// contract: install.names.archives-and-paths
func TestArchivesAndInstallationPathsFollowTheDeclaredNames(t *testing.T) {
	if name := sok.PluginArchiveName("probe", "0.2.0"); name != "probe-0.2.0.tgz" {
		t.Fatal(name)
	}
	if name, err := sok.SidecarAssetName("@scope/sidecar-worker", "0.1.1", "darwin-arm64"); err != nil || name != "scope-sidecar-worker-0.1.1-darwin-arm64.tar.gz" {
		t.Fatal(name, err)
	}
	if path, err := sok.PluginInstallPath("probe", "0.2.0"); err != nil || path != "plugins/probe/0.2.0" {
		t.Fatal(path, err)
	}
	if path, err := sok.SidecarInstallPath("@scope/sidecar-worker", "0.1.1", "darwin-arm64"); err != nil || path != "sidecars/scope-sidecar-worker/0.1.1/darwin-arm64" {
		t.Fatal(path, err)
	}
	_, err := sok.SidecarAssetName("@scope/sidecar-worker", "0.1.1", "solaris-sparc")
	rejects(t, err, "unknown platform solaris-sparc")
	_, err = sok.PluginInstallPath("../x", "0.2.0")
	rejects(t, err, "invalid plugin id ../x")
	if len(sok.Platforms) != 6 {
		t.Fatal(sok.Platforms)
	}
}

// contract: install.installed.consistency
func TestInstalledStateNamesOneVersionOfEachPluginAndSidecar(t *testing.T) {
	text := `{"format": 2, "plugins": {
		"probe": {"package": "@scope/plugin-probe", "version": "0.2.0", "path": "plugins/probe/0.2.0", "enabled": true, "previous": "0.1.0", "sidecars": {"@scope/sidecar-worker": "^0.1.0"}},
		"side": {"package": "plugin-side", "version": "1.0.0", "path": "plugins/side/1.0.0", "enabled": false, "sidecars": {}}},
		"sidecars": {"@scope/sidecar-worker": {"version": "0.1.1", "path": "sidecars/scope-sidecar-worker/0.1.1/darwin-arm64"}}}`
	state, err := sok.ValidateInstalled(decode(t, text))
	if err != nil || state.Plugins["probe"].Previous != "0.1.0" || state.Sidecars["@scope/sidecar-worker"].Version != "0.1.1" ||
		state.Plugins["probe"].Path != "plugins/probe/0.2.0" {
		t.Fatalf("%v %v", state, err)
	}
	cases := []struct {
		change func(any)
		want   string
	}{
		{func(v any) { delete(at(v, "plugins", "probe").(map[string]any), "enabled") }, "plugins/installed.json probe: enabled must be true or false"},
		{func(v any) { at(v, "plugins", "side").(map[string]any)["package"] = "@scope/plugin-probe" }, "plugins/installed.json side: package @scope/plugin-probe is installed twice"},
		{func(v any) { delete(v.(map[string]any), "sidecars") }, "plugins/installed.json sidecars: expected an object"},
		{func(v any) { delete(at(v, "plugins", "side").(map[string]any), "sidecars") }, "plugins/installed.json side sidecars: expected an object"},
		{func(v any) { v.(map[string]any)["sidecars"] = map[string]any{} }, "plugins/installed.json probe: sidecar @scope/sidecar-worker has no version in use"},
		{func(v any) {
			sidecar := at(v, "sidecars", "@scope/sidecar-worker").(map[string]any)
			sidecar["version"], sidecar["path"] = "0.2.0", "sidecars/scope-sidecar-worker/0.2.0/darwin-arm64"
		}, "plugins/installed.json probe: sidecar @scope/sidecar-worker 0.2.0 does not satisfy ^0.1.0"},
		{func(v any) {
			at(v, "sidecars").(map[string]any)["unused"] = map[string]any{"version": "1.0.0", "path": "sidecars/unused/1.0.0/darwin-arm64"}
		}, "plugins/installed.json: sidecar unused is named by no installed plugin"},
		{func(v any) { v.(map[string]any)["format"] = 1.0 }, "plugins/installed.json: format must be 2"},
		{func(v any) { at(v, "plugins", "probe").(map[string]any)["path"] = "/config/plugins/probe/0.2.0" }, "plugins/installed.json probe: path must be plugins/probe/0.2.0"},
		{func(v any) { at(v, "plugins", "probe").(map[string]any)["path"] = "plugins/probe/../side/1.0.0" }, "plugins/installed.json probe: path must be plugins/probe/0.2.0"},
		{func(v any) {
			at(v, "sidecars", "@scope/sidecar-worker").(map[string]any)["path"] = "sidecars/scope-sidecar-worker/0.1.0/darwin-arm64"
		}, "plugins/installed.json sidecar @scope/sidecar-worker: path must be sidecars/scope-sidecar-worker/0.1.1/<platform>"},
		{func(v any) {
			at(v, "sidecars", "@scope/sidecar-worker").(map[string]any)["path"] = "sidecars/scope-sidecar-worker/0.1.1/plan9-arm64"
		}, "plugins/installed.json sidecar @scope/sidecar-worker: path must be sidecars/scope-sidecar-worker/0.1.1/<platform>"},
		{func(v any) { delete(at(v, "sidecars", "@scope/sidecar-worker").(map[string]any), "path") }, "plugins/installed.json sidecar @scope/sidecar-worker: path must be sidecars/scope-sidecar-worker/0.1.1/<platform>"},
		{func(v any) { at(v, "sidecars").(map[string]any)["@scope/sidecar-worker"] = "0.1.1" }, "plugins/installed.json sidecar @scope/sidecar-worker: expected an object"},
	}
	for _, c := range cases {
		value := decode(t, text)
		c.change(value)
		_, err := sok.ValidateInstalled(value)
		rejects(t, err, c.want)
	}
}

// contract: install.installed.rejects-another-format
func TestInstalledFileOfAnotherFormatIsRejected(t *testing.T) {
	config := t.TempDir()
	file := filepath.Join(config, "plugins/installed.json")
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	former := `{"format": 1, "plugins": {}, "sidecars": {}}`
	if err := os.WriteFile(file, []byte(former), 0o644); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := run("plugin", "list", "--config-dir", config)
	want := "sok: " + file + ": plugins/installed.json: format must be 2\n"
	if code != 1 || stderr != want || readText(t, file) != former {
		t.Fatalf("code %d stderr %q want %q", code, stderr, want)
	}
}
