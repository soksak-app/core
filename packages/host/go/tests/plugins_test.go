package host_test

// Checks the plugin operations inside the application (docs/spec/installation.md#plugin-operations-in-the-application).

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
	sok "github.com/soksak-app/core/packages/sok/go/src"
)

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
	plugins, _ := support.NewPlugins(t, config)
	if text := stateText(t, plugins); text != `{"core":"`+sok.CoreVersion+`","registry":null,"index":null,"installed":{"format":3,"plugins":{},"sidecars":{}},"firstRun":true,"starter":null}` {
		t.Fatalf("state without a registry %s", text)
	}
	index, _ := support.PluginRegistry(t)
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
	if plugin := state.Installed.Plugins["probe"]; plugin.Version != sok.CoreVersion || !plugin.Enabled {
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

// contract: cli.plugin.starter-job-transitions-are-bound-to-snapshot
func TestPluginsStarterPersistsPendingAndCompletedJob(t *testing.T) {
	config := t.TempDir()
	index, _ := support.PluginRegistry(t)
	if _, err := sok.UseRegistry(config, index, sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	plugins, _ := support.NewPlugins(t, config)
	request := host.PluginsStarterRequest{State: "pending", Pack: "starter", Registry: "file://" + index, Plugins: []string{"probe"}}
	job, err := plugins.SetStarter(request)
	if err != nil || job.State != "pending" {
		t.Fatalf("pending job = %#v, %v", job, err)
	}
	if _, err := plugins.Run(host.PluginsRunRequest{Action: "install", Plugin: "probe"}); err != nil {
		t.Fatal(err)
	}
	request.State = "complete"
	job, err = plugins.SetStarter(request)
	if err != nil || job.State != "complete" {
		t.Fatalf("completed job = %#v, %v", job, err)
	}
	state, err := plugins.State()
	if err != nil || state.Starter == nil || state.Starter.State != "complete" {
		t.Fatalf("state after completion = %#v, %v", state, err)
	}
	if _, err := plugins.Run(host.PluginsRunRequest{Action: "remove", Plugin: "probe"}); err != nil {
		t.Fatal(err)
	}
	state, err = plugins.State()
	if err != nil || state.Starter == nil || state.Starter.State != "complete" || len(state.Installed.Plugins) != 0 {
		t.Fatalf("manual removal changed completed starter state: %#v, %v", state, err)
	}
}

// contract: plugins.run.changes-like-the-command
func TestPluginsRunChangesTheInstallationLikeTheCommand(t *testing.T) {
	config := t.TempDir()
	index, _ := support.PluginRegistry(t)
	if _, err := sok.UseRegistry(config, index, sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	plugins, seen := support.NewPlugins(t, config)
	installed, err := plugins.Run(host.PluginsRunRequest{Action: "install", Plugin: "probe"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(installed)
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf(`{"plugin":{"version":"%s","path":"plugins/probe/%s","enabled":true,"sidecars":{}},"sidecars":{}}`, sok.CoreVersion, sok.CoreVersion)
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
	for _, change := range seen.List() {
		if change.Plugin != "probe" {
			t.Fatalf("change %+v", change)
		}
		actions = append(actions, change.Action)
	}
	if got := strings.Join(actions, " "); got != "install update disable enable disable remove" {
		t.Fatalf("plugins-changed actions %q", got)
	}
}

// contract: plugins.run.applies-before-it-notifies
func TestPluginsRunAppliesTheChangeBeforeItNotifies(t *testing.T) {
	config := t.TempDir()
	index, _ := support.PluginRegistry(t)
	if _, err := sok.UseRegistry(config, index, sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	var steps []string
	plugins, err := host.NewPlugins(config, func() error {
		steps = append(steps, "apply")
		return nil
	}, func(change host.PluginsChanged) { steps = append(steps, "changed "+change.Action) })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := plugins.Run(host.PluginsRunRequest{Action: "install", Plugin: "probe"}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(steps, ", "); got != "apply, changed install" {
		t.Fatalf("steps %s, want the change applied to the sidecars before plugins-changed", got)
	}
}

// contract: plugins.registry.sets-like-the-command
func TestPluginsUseRegistrySetsTheRegistryLikeTheCommand(t *testing.T) {
	config := t.TempDir()
	plugins, _ := support.NewPlugins(t, config)
	index, _ := support.PluginRegistry(t)
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

// contract: cli.plugin.starter-job-transitions-are-bound-to-snapshot
func TestPluginsStarterPendingAndCompletedStatesSurviveManagerRecreation(t *testing.T) {
	config := t.TempDir()
	index, _ := support.PluginRegistry(t)
	if _, err := sok.UseRegistry(config, index, sok.DefaultFetcher); err != nil {
		t.Fatalf("use registry: %v", err)
	}
	plugins, _ := support.NewPlugins(t, config)
	request := host.PluginsStarterRequest{
		State: "pending", Pack: "starter", Registry: "file://" + index, Plugins: []string{"probe"},
	}
	if job, err := plugins.SetStarter(request); err != nil || job.State != "pending" {
		t.Fatalf("save pending starter job = %#v, %v", job, err)
	}

	plugins, _ = support.NewPlugins(t, config)
	state, err := plugins.State()
	if err != nil || state.Starter == nil || state.Starter.State != "pending" {
		t.Fatalf("pending starter state after manager recreation = %#v, %v", state, err)
	}
	if _, err := plugins.Run(host.PluginsRunRequest{Action: "install", Plugin: "probe"}); err != nil {
		t.Fatalf("install starter plugin: %v", err)
	}
	request.State = "complete"
	if job, err := plugins.SetStarter(request); err != nil || job.State != "complete" {
		t.Fatalf("save completed starter job = %#v, %v", job, err)
	}

	plugins, _ = support.NewPlugins(t, config)
	state, err = plugins.State()
	if err != nil || state.Starter == nil || state.Starter.State != "complete" {
		t.Fatalf("completed starter state after manager recreation = %#v, %v", state, err)
	}
}
