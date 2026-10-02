package tests

// plugin 설치(docs/spec/cli.md)가 archive 를 확인해 풀고 installed.json 을 한 번에 바꾸는지 검사한다.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/min-median-max/soksak/packages/sok/wailsv3/src"
)

// pluginVersions 는 plugin probe 의 version 마다 pack 한 archive 와 sidecar 0.1.0 의 release 로 registry 를 만들고
// build 한 뒤 index.json 의 경로를 돌려준다.
func pluginVersions(t *testing.T, versions ...string) string {
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
			"package.json": `{"name": "@scope/plugin-probe", "version": "` + version + `", "engines": {"soksak": "^0.0.2"},
				"soksak": {"sidecars": {"@scope/sidecar-worker": "^0.1.0"}}, "files": ["plugin.json", "ui"]}`,
			"plugin.json": `{"id": "probe", "sidecars": ["@scope/sidecar-worker"]}`,
			"ui/b.js":     "b " + version,
		})
		result := runJSON(t, "plugin", "pack", dir, releases)
		entries = append(entries, `{"version": "`+version+`", "package": {"url": "file://`+result["archive"]+`", "sha256": "`+result["sha256"]+`"},
			"engines": {"soksak": "^0.0.2"}, "sidecars": {"@scope/sidecar-worker": "^0.1.0"}}`)
	}
	sidecar := runJSON(t, "sidecar", "release", sidecarTree(t, "0.1.0"), releases, "--platform", platform)
	registry := t.TempDir()
	writeTree(t, registry, map[string]string{
		"plugins/probe.json": `{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/probe", "versions": [` + strings.Join(entries, ",") + `]}`,
		"sidecars/scope-sidecar-worker.json": `{"name": "@scope/sidecar-worker", "repository": "https://example.invalid/worker",
			"versions": [{"version": "0.1.0", "protocol": 1, "assets": {"` + platform + `":
			{"url": "file://` + sidecar["archive"] + `", "sha256": "` + sidecar["sha256"] + `"}}}]}`,
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
func TestPluginInstallExtractsCheckedArchivesAndRecordsTheState(t *testing.T) {
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
    "path": "` + filepath.Join(config, "plugins/probe/0.2.0") + `",
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
	sidecarPath := `"path": "` + filepath.Join(config, "sidecars/scope-sidecar-worker/0.1.0", platform) + `"`
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

// unsafeArchive 는 package.json 과 plugin.json 옆에 폴더 밖 경로를 담은 archive 를 쓰고 그 sha256 을 돌려준다.
func unsafeArchive(t *testing.T, path string) string {
	t.Helper()
	var data bytes.Buffer
	zipped := gzip.NewWriter(&data)
	archive := tar.NewWriter(zipped)
	for _, entry := range [][2]string{
		{"package.json", `{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"}, "files": ["plugin.json"]}`},
		{"plugin.json", `{"id": "probe"}`},
		{"../escape.txt", "outside"},
	} {
		if err := archive.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: entry[0], Mode: 0o644, Size: int64(len(entry[1]))}); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write([]byte(entry[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
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
	// index 를 쓴 뒤 archive 가 바뀌면 hash 비교가 설치를 멈춘다.
	index := pluginVersions(t, "0.2.0")
	runJSON(t, "registry", "use", index, "--config-dir", config)
	var registry map[string]any
	if err := json.Unmarshal([]byte(readText(t, index)), &registry); err != nil {
		t.Fatal(err)
	}
	url := registry["plugins"].([]any)[0].(map[string]any)["versions"].([]any)[0].(map[string]any)["package"].(map[string]any)["url"].(string)
	archive := strings.TrimPrefix(url, "file://")
	if err := os.WriteFile(archive, []byte("changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, _, stderr = run("plugin", "install", "probe", "--config-dir", config)
	if code != 1 || !strings.HasPrefix(stderr, "sok: plugin probe 0.2.0 package: "+archive+" has sha256 ") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if exists(filepath.Join(config, "plugins/installed.json")) || exists(filepath.Join(config, "plugins/probe/0.2.0")) {
		t.Fatal("a failed install changed the installation")
	}
	// 폴더 밖 경로를 담은 archive 는 풀지 않는다.
	sum := unsafeArchive(t, archive)
	registryDir := filepath.Dir(index)
	replaceIn(t, filepath.Join(registryDir, "plugins/probe.json"), `"sidecars": {"@scope/sidecar-worker": "^0.1.0"}}]`, `"sidecars": {}}]`, 1)
	text := readText(t, filepath.Join(registryDir, "plugins/probe.json"))
	old := strings.Split(strings.Split(text, `"sha256": "`)[1], `"`)[0]
	replaceIn(t, filepath.Join(registryDir, "plugins/probe.json"), old, sum, 1)
	runJSON(t, "registry", "build", registryDir)
	code, _, stderr = run("plugin", "install", "probe", "--config-dir", config)
	if code != 1 || stderr != "sok: plugin probe 0.2.0 package: archive entry ../escape.txt leaves the folder\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if exists(filepath.Join(config, "plugins/installed.json")) || exists(filepath.Join(config, "plugins/probe/0.2.0")) ||
		exists(filepath.Join(config, "plugins/probe/escape.txt")) {
		t.Fatal("an unsafe archive changed the installation")
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
	if code != 0 || !strings.Contains(stdout, `"probe": {`) || !strings.Contains(stdout, `"format": 1`) {
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
	if text := readText(t, filepath.Join(config, "plugins/installed.json")); text != "{\n  \"format\": 1,\n  \"plugins\": {},\n  \"sidecars\": {}\n}\n" {
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
	if text := stateJSON(t, config); text != `{"registry":null,"index":null,"installed":{"format":1,"plugins":{},"sidecars":{}},"firstRun":true}` {
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
	if _, err := sok.UseRegistry(config, missing); err == nil || err.Error() != missing+": no such file or directory" {
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
