package host_test

// 애플리케이션 안의 plugin 작업(docs/spec/installation.md#plugin-operations-in-the-application)을 검사한다.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// sokJSON 은 sok 명령을 실행하고 그 JSON 출력을 돌려준다.
func sokJSON(t *testing.T, args ...string) map[string]any {
	t.Helper()
	var stdout, stderr bytes.Buffer
	if code := sok.Run(args, &stdout, &stderr, sok.Options{Identifier: "com.soksak.test", PathsDir: t.TempDir(), CoreVersion: sok.CoreVersion}); code != 0 {
		t.Fatalf("sok %v: code %d stderr %s", args, code, stderr.String())
	}
	var value map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &value); err != nil {
		t.Fatalf("sok %v: %v", args, err)
	}
	return value
}

// pluginRegistry 는 fixtures/plugin-probe(sidecar 가 없는 plugin probe 0.0.7)의 archive 와 그 registry 를
// 만들고 index.json 과 archive 의 경로를 돌려준다. go test 는 package 폴더에서 실행하므로 fixture 는 그 아래에 있다.
func pluginRegistry(t *testing.T) (index, archive string) {
	t.Helper()
	releases, registry := t.TempDir(), t.TempDir()
	packed := sokJSON(t, "plugin", "pack", "fixtures/plugin-probe", releases)
	archive = packed["archive"].(string)
	writeInstalled(t, registry, map[string]string{
		"plugins/probe.json": `{"id": "probe", "package": "plugin-probe", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/probe", "versions": [{"version": "0.0.7",
			"package": {"url": "file://` + archive + `", "sha256": "` + packed["sha256"].(string) + `"},
			"engines": {"soksak": ">=0.0.1 <1.0.0"}, "sidecars": {}}]}`,
		"revoked.json": `{"plugins": [], "sidecars": []}`,
	})
	sokJSON(t, "registry", "build", registry)
	return filepath.Join(registry, "index.json"), archive
}

// changes 는 plugins-changed 알림을 모은다.
type changes struct {
	mu   sync.Mutex
	seen []host.PluginsChanged
}

func (c *changes) add(change host.PluginsChanged) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seen = append(c.seen, change)
}

func (c *changes) list() []host.PluginsChanged {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]host.PluginsChanged(nil), c.seen...)
}

func newPlugins(t *testing.T, config string) (*host.Plugins, *changes) {
	t.Helper()
	seen := &changes{}
	plugins, err := host.NewPlugins(config, seen.add)
	if err != nil {
		t.Fatal(err)
	}
	return plugins, seen
}

func stateText(t *testing.T, plugins *host.Plugins) string {
	t.Helper()
	state, err := plugins.State()
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// contract: plugins.state.reports-registry-and-installed
func TestPluginsStateReportsTheRegistryAndTheInstallation(t *testing.T) {
	config := t.TempDir()
	plugins, _ := newPlugins(t, config)
	if text := stateText(t, plugins); text != `{"registry":null,"index":null,"installed":{"format":2,"plugins":{},"sidecars":{}},"firstRun":true}` {
		t.Fatalf("state without a registry %s", text)
	}
	index, _ := pluginRegistry(t)
	if _, err := sok.UseRegistry(config, index, sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	if _, err := plugins.Run(host.PluginsRunRequest{Action: "install", Plugin: "probe"}); err != nil {
		t.Fatal(err)
	}
	var state struct {
		Registry  string         `json:"registry"`
		Index     map[string]any `json:"index"`
		Installed struct {
			Plugins map[string]sok.InstalledPlugin `json:"plugins"`
		} `json:"installed"`
	}
	if err := json.Unmarshal([]byte(stateText(t, plugins)), &state); err != nil {
		t.Fatal(err)
	}
	if state.Registry != "file://"+index || state.Index["plugins"].([]any)[0].(map[string]any)["id"] != "probe" {
		t.Fatalf("state with a registry %+v", state)
	}
	if plugin := state.Installed.Plugins["probe"]; plugin.Version != "0.0.7" || !plugin.Enabled {
		t.Fatalf("installed %+v", state.Installed)
	}
	if err := os.Remove(index); err != nil {
		t.Fatal(err)
	}
	if text := stateText(t, plugins); !strings.Contains(text, `"index":{"error":"`) || !strings.Contains(text, index) || !strings.Contains(text, `"probe":{`) {
		t.Fatalf("state with a missing index %s", text)
	}
	if err := os.WriteFile(filepath.Join(config, "plugins/installed.json"), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := plugins.State(); err == nil || !strings.Contains(err.Error(), "installed.json is not valid JSON") {
		t.Fatalf("state with an invalid installed.json: %v", err)
	}
}

// contract: plugins.run.changes-like-the-command
func TestPluginsRunChangesTheInstallationLikeTheCommand(t *testing.T) {
	config := t.TempDir()
	index, _ := pluginRegistry(t)
	if _, err := sok.UseRegistry(config, index, sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	plugins, seen := newPlugins(t, config)
	installed, err := plugins.Run(host.PluginsRunRequest{Action: "install", Plugin: "probe"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(installed)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"plugin":{"package":"plugin-probe","version":"0.0.7","path":"plugins/probe/0.0.7","enabled":true,"sidecars":{}},"sidecars":{}}`
	if string(data) != want {
		t.Fatalf("install result %s", data)
	}
	for _, action := range []string{"update", "disable", "enable"} {
		if _, err := plugins.Run(host.PluginsRunRequest{Action: action, Plugin: "probe"}); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
	}
	disabled, err := plugins.Run(host.PluginsRunRequest{Action: "disable", Plugin: "probe"})
	if err != nil || disabled.(sok.InstalledPlugin).Enabled {
		t.Fatalf("disable = %#v, %v", disabled, err)
	}
	removed, err := plugins.Run(host.PluginsRunRequest{Action: "remove", Plugin: "probe"})
	if err != nil || removed != nil {
		t.Fatalf("remove = %#v, %v", removed, err)
	}
	if _, err := os.Stat(filepath.Join(config, "plugins/probe")); !os.IsNotExist(err) {
		t.Fatalf("remove kept the plugin folder: %v", err)
	}
	var actions []string
	for _, change := range seen.list() {
		if change.Plugin != "probe" {
			t.Fatalf("change %+v", change)
		}
		actions = append(actions, change.Action)
	}
	if got := strings.Join(actions, " "); got != "install update disable enable disable remove" {
		t.Fatalf("plugins-changed actions %q", got)
	}
}

// contract: plugins.run.rejects-invalid-and-concurrent
func TestPluginsRunRejectsInvalidAndConcurrentOperations(t *testing.T) {
	config := t.TempDir()
	index, archive := pluginRegistry(t)
	if _, err := sok.UseRegistry(config, index, sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	plugins, seen := newPlugins(t, config)
	for _, request := range []struct {
		request host.PluginsRunRequest
		want    string
	}{
		{host.PluginsRunRequest{Action: "rename", Plugin: "probe"}, `unknown plugin action "rename"`},
		{host.PluginsRunRequest{Action: "install", Plugin: 5.0}, "plugin must be a non-empty string"},
		{host.PluginsRunRequest{Action: "install", Plugin: ""}, "plugin must be a non-empty string"},
		{host.PluginsRunRequest{Action: "remove", Plugin: "probe"}, "plugin probe is not installed"},
	} {
		if _, err := plugins.Run(request.request); err == nil || err.Error() != request.want {
			t.Fatalf("%+v: %v, want %s", request.request, err, request.want)
		}
	}
	// archive 를 FIFO 로 바꾸면 설치는 그 FIFO 를 읽는 동안 멈춘다. FIFO 를 쓰기로 연 순간 설치는 실행 중이다.
	data, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(archive); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(archive, 0o644); err != nil {
		t.Fatal(err)
	}
	first := make(chan error, 1)
	go func() {
		_, err := plugins.Run(host.PluginsRunRequest{Action: "install", Plugin: "probe"})
		first <- err
	}()
	writer, err := os.OpenFile(archive, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := plugins.Run(host.PluginsRunRequest{Action: "install", Plugin: "probe"}); err == nil || err.Error() != "another plugin operation is running" {
		t.Fatalf("concurrent install: %v", err)
	}
	if len(seen.list()) != 0 {
		t.Fatalf("rejected operations sent %+v", seen.list())
	}
	if _, err := writer.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-first; err != nil {
		t.Fatalf("first install: %v", err)
	}
	if got := seen.list(); len(got) != 1 || got[0] != (host.PluginsChanged{Action: "install", Plugin: "probe"}) {
		t.Fatalf("plugins-changed %+v", got)
	}
}

// contract: plugins.registry.sets-like-the-command
func TestPluginsUseRegistrySetsTheRegistryLikeTheCommand(t *testing.T) {
	config := t.TempDir()
	plugins, _ := newPlugins(t, config)
	index, _ := pluginRegistry(t)
	result, err := plugins.UseRegistry(host.PluginsRegistryRequest{Index: index})
	if err != nil {
		t.Fatal(err)
	}
	if data, _ := json.Marshal(result); string(data) != `{"index":"file://`+index+`"}` {
		t.Fatalf("result %s", data)
	}
	if data, err := os.ReadFile(filepath.Join(config, "plugins/registry.json")); err != nil || string(data) != `{"format":1,"index":"file://`+index+`"}`+"\n" {
		t.Fatalf("registry.json %q %v", data, err)
	}
	for _, value := range []any{nil, "", 3.0} {
		if _, err := plugins.UseRegistry(host.PluginsRegistryRequest{Index: value}); err == nil || err.Error() != "index must be a non-empty string" {
			t.Fatalf("index %v: %v", value, err)
		}
	}
}
