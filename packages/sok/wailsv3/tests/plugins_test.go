package tests

// plugin 설치(docs/spec/cli.md)가 release 를 확인해 풀고 installed.json 을 한 번에 바꾸는지 검사한다.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// pluginVersions 는 plugin probe 의 version 마다 pack 한 release 와 sidecar 0.1.0 의 release 로 registry 를 만들고
// build 한 뒤 index.json 의 경로를 돌려준다.
func pluginVersions(t *testing.T, versions ...string) string {
	t.Helper()
	return pluginVersionsFor(t, "0.0.2", versions...)
}

// pluginVersionsFor 는 plugin 이 core version core 를 요구하는 registry 를 만든다.
func pluginVersionsFor(t *testing.T, core string, versions ...string) string {
	t.Helper()
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	releases := t.TempDir()
	var entries []string
	for _, version := range versions {
		dir := t.TempDir()
		writeTree(t, dir, map[string]string{
			"package.json": `{"name": "@scope/plugin-probe", "version": "` + version + `", "engines": {"soksak": "^` + core + `"},
				"files": ["plugin.json", "ui"]}`,
			"plugin.json": `{"id": "probe", "dependencies": {"@scope/sidecar-worker": "^0.1.0"}}`,
			"ui/b.js":     "b " + version,
		})
		result := runJSON(t, "plugin", "pack", dir, releases)
		entries = append(entries, `{"version": "`+version+`", "release": {"url": "file://`+result["release"]+`", "sha256": "`+result["sha256"]+`"},
			"engines": {"soksak": "^`+core+`"}, "sidecars": {"@scope/sidecar-worker": "^0.1.0"}}`)
	}
	sidecar := runJSON(t, "sidecar", "release", sidecarTree(t, "0.1.0"), releases, "--platform", platform)
	registry := t.TempDir()
	writeTree(t, registry, map[string]string{
		"plugins/probe.json": `{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/probe", "versions": [` + strings.Join(entries, ",") + `]}`,
		"sidecars/scope-sidecar-worker.json": `{"name": "@scope/sidecar-worker", "repository": "https://example.invalid/worker",
			"versions": [{"version": "0.1.0", "protocol": 1, "releases": {"` + platform + `":
			{"url": "file://` + sidecar["release"] + `", "sha256": "` + sidecar["sha256"] + `"}}}]}`,
		"revoked.json": `{"plugins": [], "sidecars": []}`,
	})
	runJSON(t, "registry", "build", registry)
	return filepath.Join(registry, "index.json")
}

func runJSON(t *testing.T, args ...string) map[string]string {
	t.Helper()
	code, stdout, stderr := run(args...)
	if code != 0 {
		t.Fatalf("%v: code %d stderr %q", args, code, stderr)
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(stdout), &value); err != nil {
		t.Fatalf("%v: %v", args, err)
	}
	result := map[string]string{}
	for key, item := range value {
		result[key] = fmt.Sprint(item)
	}
	return result
}

func readText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// contract: cli.plugin.install-extracts-and-records
func TestPluginInstallExtractsCheckedReleasesAndRecordsTheState(t *testing.T) {
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	index := pluginVersions(t, "0.2.0")
	config := t.TempDir()
	if result := runJSON(t, "registry", "use", index, "--config-dir", config); result["index"] != "file://"+index {
		t.Fatalf("registry use %v", result)
	}
	if text := readText(t, filepath.Join(config, "plugins/registry.json")); text != `{"format":1,"index":"file://`+index+`"}`+"\n" {
		t.Fatalf("registry.json %q", text)
	}
	code, stdout, stderr := run("plugin", "install", "probe", "--config-dir", config)
	want := `{
  "plugin": {
    "package": "@scope/plugin-probe",
    "version": "0.2.0",
    "path": "plugins/probe/0.2.0",
    "enabled": true,
    "sidecars": {
      "@scope/sidecar-worker": "^0.1.0"
    }
  },
  "sidecars": {
    "@scope/sidecar-worker": "0.1.0"
  }
}
`
	if code != 0 || stdout != want {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	if text := readText(t, filepath.Join(config, "plugins/probe/0.2.0/ui/b.js")); text != "b 0.2.0" {
		t.Fatalf("ui/b.js %q", text)
	}
	worker := filepath.Join(config, "sidecars/scope-sidecar-worker/0.1.0", platform, "build/worker")
	if info, err := os.Stat(worker); err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("worker %v %v", info, err)
	}
	installed := readText(t, filepath.Join(config, "plugins/installed.json"))
	sidecarPath := `"path": "sidecars/scope-sidecar-worker/0.1.0/` + platform + `"`
	if !strings.Contains(installed, sidecarPath) || !strings.Contains(installed, `"version": "0.2.0"`) {
		t.Fatalf("installed.json %s", installed)
	}
	// 같은 version 을 다시 설치하면 아무것도 바꾸지 않는다.
	if code, again, _ := run("plugin", "install", "probe", "--config-dir", config); code != 0 || again != stdout {
		t.Fatalf("repeat %d %q", code, again)
	}
	if text := readText(t, filepath.Join(config, "plugins/installed.json")); text != installed {
		t.Fatalf("repeat changed installed.json %s", text)
	}
}

// unsafeRelease 는 package.json 과 plugin.json 옆에 폴더 밖 경로를 담은 release 를 쓰고 그 sha256 을 돌려준다.
func unsafeRelease(t *testing.T, path string) string {
	t.Helper()
	var data bytes.Buffer
	zipped := gzip.NewWriter(&data)
	release := tar.NewWriter(zipped)
	for _, entry := range [][2]string{
		{"package.json", `{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"}, "files": ["plugin.json"]}`},
		{"plugin.json", `{"id": "probe"}`},
		{"../escape.txt", "outside"},
	} {
		if err := release.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: entry[0], Mode: 0o644, Size: int64(len(entry[1]))}); err != nil {
			t.Fatal(err)
		}
		if _, err := release.Write([]byte(entry[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := release.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data.Bytes())
	return hex.EncodeToString(sum[:])
}

// contract: cli.plugin.install-failure-keeps-state
func TestPluginInstallFailureKeepsThePreviousState(t *testing.T) {
	config := t.TempDir()
	code, _, stderr := run("plugin", "install", "probe", "--config-dir", config)
	if code != 1 || stderr != "sok: "+filepath.Join(config, "plugins/registry.json")+" does not exist; run sok registry use <index.json>\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	// index 를 쓴 뒤 release 가 바뀌면 hash 비교가 설치를 멈춘다.
	index := pluginVersions(t, "0.2.0")
	runJSON(t, "registry", "use", index, "--config-dir", config)
	var registry map[string]any
	if err := json.Unmarshal([]byte(readText(t, index)), &registry); err != nil {
		t.Fatal(err)
	}
	url := registry["plugins"].([]any)[0].(map[string]any)["versions"].([]any)[0].(map[string]any)["release"].(map[string]any)["url"].(string)
	release := strings.TrimPrefix(url, "file://")
	if err := os.WriteFile(release, []byte("changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, _, stderr = run("plugin", "install", "probe", "--config-dir", config)
	if code != 1 || !strings.HasPrefix(stderr, "sok: plugin probe 0.2.0 package: "+release+" has sha256 ") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if exists(filepath.Join(config, "plugins/installed.json")) || exists(filepath.Join(config, "plugins/probe/0.2.0")) {
		t.Fatal("a failed install changed the installation")
	}
	// 폴더 밖 경로를 담은 release 는 풀지 않는다.
	sum := unsafeRelease(t, release)
	registryDir := filepath.Dir(index)
	replaceIn(t, filepath.Join(registryDir, "plugins/probe.json"), `"sidecars": {"@scope/sidecar-worker": "^0.1.0"}}]`, `"sidecars": {}}]`, 1)
	text := readText(t, filepath.Join(registryDir, "plugins/probe.json"))
	old := strings.Split(strings.Split(text, `"sha256": "`)[1], `"`)[0]
	replaceIn(t, filepath.Join(registryDir, "plugins/probe.json"), old, sum, 1)
	runJSON(t, "registry", "build", registryDir)
	code, _, stderr = run("plugin", "install", "probe", "--config-dir", config)
	if code != 1 || stderr != "sok: plugin probe 0.2.0 package: release entry ../escape.txt leaves the folder\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if exists(filepath.Join(config, "plugins/installed.json")) || exists(filepath.Join(config, "plugins/probe/0.2.0")) ||
		exists(filepath.Join(config, "plugins/probe/escape.txt")) {
		t.Fatal("an unsafe release changed the installation")
	}
}

// contract: cli.plugin.update-remove-enable-list
func TestPluginUpdateKeepsPreviousAndRemoveDeletesTheFolders(t *testing.T) {
	config := t.TempDir()
	runJSON(t, "registry", "use", pluginVersions(t, "0.2.0"), "--config-dir", config)
	code, _, stderr := run("plugin", "update", "probe", "--config-dir", config)
	if code != 1 || stderr != "sok: plugin probe is not installed\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	run("plugin", "install", "probe", "--config-dir", config)
	code, stdout, _ := run("plugin", "disable", "probe", "--config-dir", config)
	if code != 0 || !strings.Contains(stdout, `"enabled": false`) {
		t.Fatalf("disable %d %q", code, stdout)
	}
	for _, step := range [][2]string{{"0.3.0", "0.2.0"}, {"0.4.0", "0.3.0"}} {
		runJSON(t, "registry", "use", pluginVersions(t, "0.2.0", step[0]), "--config-dir", config)
		code, stdout, stderr := run("plugin", "update", "probe", "--config-dir", config)
		if code != 0 || !strings.Contains(stdout, `"version": "`+step[0]+`"`) || !strings.Contains(stdout, `"previous": "`+step[1]+`"`) ||
			!strings.Contains(stdout, `"enabled": false`) {
			t.Fatalf("update to %s: %d %q %q", step[0], code, stdout, stderr)
		}
	}
	entries, err := os.ReadDir(filepath.Join(config, "plugins/probe"))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if fmt.Sprint(names) != "[0.3.0 0.4.0]" {
		t.Fatalf("version folders %v", names)
	}
	code, stdout, _ = run("plugin", "list", "--config-dir", config)
	if code != 0 || !strings.Contains(stdout, `"probe": {`) || !strings.Contains(stdout, `"format": 2`) {
		t.Fatalf("list %d %q", code, stdout)
	}
	code, stdout, _ = run("plugin", "enable", "probe", "--config-dir", config)
	if code != 0 || !strings.Contains(stdout, `"enabled": true`) {
		t.Fatalf("enable %d %q", code, stdout)
	}
	code, stdout, _ = run("plugin", "remove", "probe", "--config-dir", config)
	if code != 0 || stdout != "null\n" {
		t.Fatalf("remove %d %q", code, stdout)
	}
	if exists(filepath.Join(config, "plugins/probe")) || exists(filepath.Join(config, "sidecars/scope-sidecar-worker")) {
		t.Fatal("remove left plugin or sidecar folders")
	}
	if text := readText(t, filepath.Join(config, "plugins/installed.json")); text != "{\n  \"format\": 2,\n  \"plugins\": {},\n  \"sidecars\": {}\n}\n" {
		t.Fatalf("installed.json %q", text)
	}
	code, _, stderr = run("plugin", "remove", "probe", "--config-dir", config)
	if code != 1 || stderr != "sok: plugin probe is not installed\n" {
		t.Fatalf("second remove %d %q", code, stderr)
	}
}

// stateJSON 은 ReadPluginsState 의 결과를 JSON 문장으로 만든다.
func stateJSON(t *testing.T, config string) string {
	t.Helper()
	state, err := sok.ReadPluginsState(config)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// contract: cli.plugin.state-reads-registry-and-installed
func TestPluginsStateReportsTheRegistryAndTheInstallation(t *testing.T) {
	config := t.TempDir()
	if text := stateJSON(t, config); text != `{"registry":null,"index":null,"installed":{"format":2,"plugins":{},"sidecars":{}},"firstRun":true}` {
		t.Fatalf("state without a registry = %s", text)
	}
	index := pluginVersions(t, "0.2.0")
	runJSON(t, "registry", "use", index, "--config-dir", config)
	if _, err := sok.RunPluginAction(config, "install", "probe", "0.0.2", mustPlatform(t)); err != nil {
		t.Fatal(err)
	}
	state, err := sok.ReadPluginsState(config)
	if err != nil {
		t.Fatal(err)
	}
	if state.Registry == nil || *state.Registry != "file://"+index {
		t.Fatalf("registry = %v", state.Registry)
	}
	if checked, ok := state.Index.(*sok.Index); !ok || len(checked.Plugins) != 1 || checked.Plugins[0].ID != "probe" {
		t.Fatalf("index = %#v", state.Index)
	}
	if plugin := state.Installed.Plugins["probe"]; plugin.Version != "0.2.0" || !plugin.Enabled {
		t.Fatalf("installed = %#v", state.Installed)
	}
	if state.FirstRun {
		t.Fatal("the state after an install reports a first run")
	}
	// 읽지 못한 index 는 오류를 index 자리에 담고, 설치 상태는 그대로 보고한다.
	if err := os.Remove(index); err != nil {
		t.Fatal(err)
	}
	if text := stateJSON(t, config); !strings.Contains(text, `"index":{"error":"`+index+`: no such file or directory"}`) || !strings.Contains(text, `"probe":{`) {
		t.Fatalf("state with a missing index = %s", text)
	}
	if err := os.WriteFile(filepath.Join(config, "plugins/installed.json"), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := sok.ReadPluginsState(config); err == nil || !strings.Contains(err.Error(), "installed.json is not valid JSON") {
		t.Fatalf("state with an invalid installed.json: %v", err)
	}
}

// contract: cli.plugin.action-runs-the-command
func TestRunPluginActionMatchesThePluginCommands(t *testing.T) {
	config := t.TempDir()
	runJSON(t, "registry", "use", pluginVersions(t, "0.2.0"), "--config-dir", config)
	if _, err := sok.RunPluginAction(config, "install", "probe", "0.0.2", mustPlatform(t)); err != nil {
		t.Fatal(err)
	}
	disabled, err := sok.RunPluginAction(config, "disable", "probe", "0.0.2", "")
	if err != nil {
		t.Fatal(err)
	}
	if plugin, ok := disabled.(sok.InstalledPlugin); !ok || plugin.Enabled {
		t.Fatalf("disable = %#v", disabled)
	}
	_, stdout, _ := run("plugin", "list", "--config-dir", config)
	if !strings.Contains(stdout, `"enabled": false`) {
		t.Fatalf("plugin list after disable %s", stdout)
	}
	if _, err := sok.RunPluginAction(config, "rename", "probe", "0.0.2", ""); err == nil || err.Error() != `unknown plugin action "rename"` {
		t.Fatalf("unknown action: %v", err)
	}
	if removed, err := sok.RunPluginAction(config, "remove", "probe", "0.0.2", ""); err != nil || removed != nil {
		t.Fatalf("remove = %v, %v", removed, err)
	}
	if exists(filepath.Join(config, "plugins/probe")) {
		t.Fatal("remove kept the plugin folder")
	}
}

func mustPlatform(t *testing.T) string {
	t.Helper()
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	return platform
}

// contract: cli.file.errors-name-the-path-and-the-reason
func TestFileErrorsNameThePathAndTheReason(t *testing.T) {
	config := t.TempDir()
	missing := filepath.Join(config, "missing.json")
	if _, err := sok.UseRegistry(config, missing, sok.DefaultFetcher); err == nil || err.Error() != missing+": no such file or directory" {
		t.Fatalf("missing index error = %v", err)
	}
	installed := filepath.Join(config, "plugins", "installed.json")
	if err := os.MkdirAll(filepath.Dir(installed), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(installed, []byte("{}"), 0o000); err != nil {
		t.Fatal(err)
	}
	_, err := sok.ReadPluginsState(config)
	if chmodErr := os.Chmod(installed, 0o644); chmodErr != nil {
		t.Fatal(chmodErr)
	}
	if err == nil || err.Error() != installed+": permission denied" {
		t.Fatalf("unreadable installed state error = %v", err)
	}
}

// contract: cli.plugin.install-modes-ignore-the-umask
func TestPluginInstallSetsTheModesWhateverTheUmask(t *testing.T) {
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	// 빌드한 sok 은 이 package 의 CoreVersion 으로 plugin 을 고른다.
	index := pluginVersionsFor(t, sok.CoreVersion, "0.2.0")
	config := t.TempDir()
	runJSON(t, "registry", "use", index, "--config-dir", config)
	// 프로세스의 umask 는 실행 파일 단위이므로 sok 을 빌드해 umask 077 의 shell 에서 실행한다.
	binary := filepath.Join(t.TempDir(), "sok")
	if output, err := exec.Command("go", "build", "-o", binary, "github.com/soksak-app/core/packages/sok/wailsv3/src/cmd/sok").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, output)
	}
	install := exec.Command("sh", "-c", `umask 077 && exec "$0" "$@"`, binary, "plugin", "install", "probe", "--config-dir", config)
	if output, err := install.CombinedOutput(); err != nil {
		t.Fatalf("plugin install: %v\n%s", err, output)
	}
	for path, want := range map[string]os.FileMode{
		filepath.Join(config, "sidecars/scope-sidecar-worker/0.1.0", platform, "build/worker"): 0o755,
		filepath.Join(config, "plugins/probe/0.2.0/ui/b.js"):                                   0o644,
	} {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != want {
			t.Fatalf("%s: mode %v err %v, want %v", path, info.Mode().Perm(), err, want)
		}
	}
}

// dependent is a test plugin version with plugin.json dependencies. Its package is @scope/plugin-<id>.
type dependent struct {
	id, version  string
	dependencies map[string]string
}

func jsonText(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// dependencyRegistry writes the entry files of a registry folder with a packed release of each version and the release
// of sidecar worker 0.1.0, writes index.json from the same entries, and returns the registry folder. The sidecars of
// the index hold only the dependencies that start with @scope/sidecar-.
func dependencyRegistry(t *testing.T, versions ...dependent) string {
	t.Helper()
	platform := mustPlatform(t)
	releases := t.TempDir()
	type entry = map[string]any
	plugins := map[string]entry{}
	var ids []string
	for _, item := range versions {
		dir := t.TempDir()
		writeTree(t, dir, map[string]string{
			"package.json": `{"name": "@scope/plugin-` + item.id + `", "version": "` + item.version + `", "engines": {"soksak": "^0.0.2"},
				"files": ["plugin.json"]}`,
			"plugin.json": jsonText(t, entry{"id": item.id, "dependencies": item.dependencies}),
		})
		result := runJSON(t, "plugin", "pack", dir, releases)
		sidecars := map[string]string{}
		for name, rng := range item.dependencies {
			if strings.HasPrefix(name, "@scope/sidecar-") {
				sidecars[name] = rng
			}
		}
		if plugins[item.id] == nil {
			ids = append(ids, item.id)
			plugins[item.id] = entry{"id": item.id, "package": "@scope/plugin-" + item.id, "name": item.id, "description": "검사용 plugin.",
				"license": "MIT", "repository": "https://example.invalid/" + item.id, "versions": []any{}}
		}
		plugins[item.id]["versions"] = append(plugins[item.id]["versions"].([]any), entry{"version": item.version,
			"release": entry{"url": "file://" + result["release"], "sha256": result["sha256"]}, "engines": entry{"soksak": "^0.0.2"}, "sidecars": sidecars})
	}
	sidecar := runJSON(t, "sidecar", "release", sidecarTree(t, "0.1.0"), releases, "--platform", platform)
	worker := entry{"name": "@scope/sidecar-worker", "repository": "https://example.invalid/worker", "versions": []any{entry{"version": "0.1.0",
		"protocol": 1, "releases": entry{platform: entry{"url": "file://" + sidecar["release"], "sha256": sidecar["sha256"]}}}}}
	revoked := entry{"plugins": []any{}, "sidecars": []any{}}
	files := map[string]string{"sidecars/scope-sidecar-worker.json": jsonText(t, worker), "revoked.json": jsonText(t, revoked)}
	slices.Sort(ids)
	list := []any{}
	for _, id := range ids {
		files["plugins/"+id+".json"] = jsonText(t, plugins[id])
		list = append(list, plugins[id])
	}
	files["index.json"] = jsonText(t, entry{"format": 1, "plugins": list, "sidecars": []any{worker}, "packs": []any{}, "revoked": revoked})
	registry := t.TempDir()
	writeTree(t, registry, files)
	return registry
}

func base(version string) dependent {
	return dependent{"base", version, map[string]string{"@scope/sidecar-worker": "^0.1.0"}}
}

func ext(rng string) dependent {
	return dependent{"ext", "1.0.0", map[string]string{"@scope/plugin-base": rng}}
}

// useRegistry makes the configuration directory use the index.json of the registry folder.
func useRegistry(t *testing.T, config, registry string) {
	t.Helper()
	runJSON(t, "registry", "use", filepath.Join(registry, "index.json"), "--config-dir", config)
}

func installedOf(t *testing.T, config string) *sok.InstalledState {
	t.Helper()
	state, err := sok.ReadInstalled(config)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

// succeeds runs a sok command and stops the test when it fails.
func succeeds(t *testing.T, args ...string) string {
	t.Helper()
	code, stdout, stderr := run(args...)
	if code != 0 {
		t.Fatalf("%v: code %d stderr %q", args, code, stderr)
	}
	return stdout
}

// contract: cli.plugin.dependencies-install
func TestPluginInstallInstallsThePluginDependencies(t *testing.T) {
	full := dependencyRegistry(t, base("1.0.0"), base("1.1.0"), base("2.0.0"), ext("^1.0.0"))
	// A provider that is not installed gets the newest version that satisfies the range.
	config := t.TempDir()
	useRegistry(t, config, full)
	stdout := succeeds(t, "plugin", "install", "ext", "--config-dir", config)
	want := `{
  "plugin": {
    "package": "@scope/plugin-ext",
    "version": "1.0.0",
    "path": "plugins/ext/1.0.0",
    "enabled": true,
    "sidecars": {}
  },
  "sidecars": {}
}
`
	if stdout != want {
		t.Fatalf("install ext %q", stdout)
	}
	state := installedOf(t, config)
	if provider := state.Plugins["base"]; provider.Version != "1.1.0" || !provider.Enabled || provider.Previous != "" ||
		fmt.Sprint(provider.Sidecars) != "map[@scope/sidecar-worker:^0.1.0]" || state.Sidecars["@scope/sidecar-worker"].Version != "0.1.0" {
		t.Fatalf("installed %+v", state)
	}
	if !exists(filepath.Join(config, "plugins/base/1.1.0/plugin.json")) || !exists(filepath.Join(config, "plugins/ext/1.0.0/plugin.json")) {
		t.Fatal("install ext did not extract both plugins")
	}
	// An installed provider that satisfies the range is kept and enabled.
	config = t.TempDir()
	useRegistry(t, config, dependencyRegistry(t, base("1.0.0")))
	succeeds(t, "plugin", "install", "base", "--config-dir", config)
	succeeds(t, "plugin", "disable", "base", "--config-dir", config)
	useRegistry(t, config, full)
	succeeds(t, "plugin", "install", "ext", "--config-dir", config)
	if provider := installedOf(t, config).Plugins["base"]; provider.Version != "1.0.0" || !provider.Enabled || provider.Previous != "" {
		t.Fatalf("kept provider %+v", provider)
	}
	// An installed provider that does not satisfy the range gets the newest version that satisfies it.
	config = t.TempDir()
	useRegistry(t, config, full)
	succeeds(t, "plugin", "install", "base", "--config-dir", config)
	succeeds(t, "plugin", "install", "ext", "--config-dir", config)
	if provider := installedOf(t, config).Plugins["base"]; provider.Version != "1.1.0" || provider.Previous != "2.0.0" {
		t.Fatalf("replaced provider %+v", provider)
	}
}

// pluginFolders lists the names in the plugins folder of the configuration directory.
func pluginFolders(t *testing.T, config string) string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(config, "plugins"))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return strings.Join(names, " ")
}

// contract: cli.plugin.dependencies-reject
func TestPluginInstallRejectsUnresolvablePluginDependencies(t *testing.T) {
	for _, c := range []struct {
		plugin   string
		versions []dependent
		want     string
	}{
		{"ext", []dependent{{"ext", "1.0.0", map[string]string{"@scope/plugin-gone": "^1.0.0"}}},
			"sok: ext 1.0.0: dependency @scope/plugin-gone is neither a plugin nor a sidecar of the registry\n"},
		{"ext", []dependent{base("1.0.0"), ext("^2.0.0")},
			"sok: plugin base has no version for core 0.0.2 that satisfies every installed plugin: ext 1.0.0 needs ^2.0.0\n"},
		{"first", []dependent{{"first", "1.0.0", map[string]string{"@scope/plugin-second": "^1.0.0"}},
			{"second", "1.0.0", map[string]string{"@scope/plugin-first": "^1.0.0"}}},
			"sok: plugin dependency cycle: first -> second -> first\n"},
	} {
		config := t.TempDir()
		useRegistry(t, config, dependencyRegistry(t, c.versions...))
		code, _, stderr := run("plugin", "install", c.plugin, "--config-dir", config)
		if code != 1 || stderr != c.want {
			t.Fatalf("install %s: code %d stderr %q, want %q", c.plugin, code, stderr, c.want)
		}
		if folders := pluginFolders(t, config); folders != "registry.json" {
			t.Fatalf("install %s changed the installation: %s", c.plugin, folders)
		}
	}
	// A provider that the index does not list is not a plugin dependency, even when it is installed.
	config := t.TempDir()
	useRegistry(t, config, dependencyRegistry(t, base("1.0.0")))
	succeeds(t, "plugin", "install", "base", "--config-dir", config)
	before := readText(t, filepath.Join(config, "plugins/installed.json"))
	useRegistry(t, config, dependencyRegistry(t, ext("^1.0.0")))
	code, _, stderr := run("plugin", "install", "ext", "--config-dir", config)
	if code != 1 || stderr != "sok: ext 1.0.0: dependency @scope/plugin-base is neither a plugin nor a sidecar of the registry\n" {
		t.Fatalf("provider missing from the index: code %d stderr %q", code, stderr)
	}
	if readText(t, filepath.Join(config, "plugins/installed.json")) != before || exists(filepath.Join(config, "plugins/ext")) {
		t.Fatal("a failed install changed the installation")
	}
}

// contract: cli.plugin.dependencies-update
func TestPluginUpdateSelectsAProviderVersionThatSatisfiesEveryDependent(t *testing.T) {
	config := t.TempDir()
	useRegistry(t, config, dependencyRegistry(t, base("1.0.0"), ext("^1.0.0")))
	succeeds(t, "plugin", "install", "ext", "--config-dir", config)
	useRegistry(t, config, dependencyRegistry(t, base("1.0.0"), base("1.1.0"), base("2.0.0"), ext("^1.0.0")))
	succeeds(t, "plugin", "update", "base", "--config-dir", config)
	if provider := installedOf(t, config).Plugins["base"]; provider.Version != "1.1.0" || provider.Previous != "1.0.0" {
		t.Fatalf("update with a dependent %+v", provider)
	}
	// A disabled dependent also names a range.
	succeeds(t, "plugin", "disable", "ext", "--config-dir", config)
	succeeds(t, "plugin", "update", "base", "--config-dir", config)
	if provider := installedOf(t, config).Plugins["base"]; provider.Version != "1.1.0" {
		t.Fatalf("update with a disabled dependent %+v", provider)
	}
	succeeds(t, "plugin", "remove", "ext", "--config-dir", config)
	succeeds(t, "plugin", "update", "base", "--config-dir", config)
	if provider := installedOf(t, config).Plugins["base"]; provider.Version != "2.0.0" || provider.Previous != "1.1.0" {
		t.Fatalf("update without a dependent %+v", provider)
	}
}

// contract: cli.plugin.dependencies-required
func TestPluginRemoveAndDisableRefuseAPluginThatAnEnabledPluginRequires(t *testing.T) {
	config := t.TempDir()
	useRegistry(t, config, dependencyRegistry(t, base("1.0.0"), ext("^1.0.0")))
	succeeds(t, "plugin", "install", "ext", "--config-dir", config)
	before := readText(t, filepath.Join(config, "plugins/installed.json"))
	for _, action := range []string{"remove", "disable"} {
		code, _, stderr := run("plugin", action, "base", "--config-dir", config)
		if code != 1 || stderr != "sok: plugin base is required by ext ^1.0.0\n" {
			t.Fatalf("%s base: code %d stderr %q", action, code, stderr)
		}
		if readText(t, filepath.Join(config, "plugins/installed.json")) != before || !exists(filepath.Join(config, "plugins/base/1.0.0/plugin.json")) {
			t.Fatalf("a refused %s changed the installation", action)
		}
	}
	// A disabled plugin does not require its provider.
	succeeds(t, "plugin", "disable", "ext", "--config-dir", config)
	succeeds(t, "plugin", "disable", "base", "--config-dir", config)
	if stdout := succeeds(t, "plugin", "remove", "base", "--config-dir", config); stdout != "null\n" {
		t.Fatalf("remove base %q", stdout)
	}
}
