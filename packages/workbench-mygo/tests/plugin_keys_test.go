package workbench_test

// The plugin keys of the mygo workbench (docs/spec/plugins.md#plugin-data, F1210-4): a key of data with the scope plugin is read, written,
// replaced and followed by a view through the plugin store of the host, and the store holds the value for every project.

import (
	"encoding/json"
	"strings"
	"testing"
)

// pluginKeyShell is a shell whose plugin textprobe declares the plugin key accounts beside its project keys.
func pluginKeyShell(t *testing.T) (*shellFixture, *surfaceHost) {
	t.Helper()
	declared := `"point": {"schema": {"type": "object"}, "default": {}}},`
	document := installedDocument
	if !strings.Contains(document, declared) {
		t.Fatal("the installed document declares no key point of textprobe")
	}
	document = strings.Replace(document, declared,
		`"point": {"schema": {"type": "object"}, "default": {}}, "accounts": {"schema": {"type": "array", "items": {"type": "string"}}, "default": [], "scope": "plugin"}},`, 1)
	return surfaceShellOf(t, document)
}

// resultText returns the JSON text of the result of a reply.
func resultText(t *testing.T, reply map[string]any) string {
	t.Helper()
	if reply["error"] != nil {
		t.Fatalf("the call failed: %v", reply)
	}
	text, err := json.Marshal(reply["result"])
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

// A view reads, writes and replaces the plugin key through the plugin store, and the project data holds none of it.
func TestAViewReadsWritesAndReplacesAPluginKeyThroughThePluginStore(t *testing.T) {
	f, stored := pluginKeyShell(t)
	surface := pluginSurface(t, stored, "textprobe")
	if got := resultText(t, viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "accounts"})); got != `[]` {
		t.Fatalf("the plugin key reads %s before a write, want the default []", got)
	}
	viewCall(t, f, stored, surface, "runtime.data.on", nil)
	if got := resultText(t, viewCall(t, f, stored, surface, "runtime.data.set", map[string]any{"key": "accounts", "value": []string{"a"}})); got != `null` {
		t.Fatalf("the write answered %s", got)
	}
	if entry, _ := json.Marshal(f.host.pluginData["textprobe"]["accounts"]); string(entry) != `{"format":1,"value":["a"]}` {
		t.Fatalf("the store holds %s", entry)
	}
	if got := resultText(t, viewCall(t, f, stored, surface, "runtime.data.replace", map[string]any{"key": "accounts", "base": []string{"a"}, "value": []string{"a", "b"}})); got != `true` {
		t.Fatalf("the replace on the stored value answered %s", got)
	}
	if got := resultText(t, viewCall(t, f, stored, surface, "runtime.data.replace", map[string]any{"key": "accounts", "base": []string{"a"}, "value": []string{"c"}})); got != `false` {
		t.Fatalf("the replace on an earlier value answered %s", got)
	}
	if got := resultText(t, viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "accounts"})); got != `["a","b"]` {
		t.Fatalf("the plugin key reads %s", got)
	}
	if got := viewEventKeys(t, stored, surface, "data"); len(got) != 2 || got[0] != "accounts" || got[1] != "accounts" {
		t.Fatalf("the view heard %v, want two changes of accounts", got)
	}
	if projects, _ := json.Marshal(f.host.projects); strings.Contains(string(projects), `"accounts"`) {
		t.Fatalf("the stored projects hold the plugin key: %s", projects)
	}
}

// A plugin key that another window stored reaches a view of a window with a project, and a stored entry of another format fails the read.
func TestAPluginKeyOfAnotherWindowReachesAViewAndAnotherFormatFails(t *testing.T) {
	f, stored := pluginKeyShell(t)
	surface := pluginSurface(t, stored, "textprobe")
	viewCall(t, f, stored, surface, "runtime.data.on", nil)
	f.host.pluginData = map[string]map[string]any{"textprobe": {"accounts": map[string]any{"format": 1, "value": []string{"other"}}}}
	f.shell.Event("workspace-changed", nil)
	f.settle()
	if got := viewEventKeys(t, stored, surface, "data"); len(got) != 1 || got[0] != "accounts" {
		t.Fatalf("the view heard %v, want one change of accounts", got)
	}
	if got := resultText(t, viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "accounts"})); got != `["other"]` {
		t.Fatalf("the plugin key reads %s", got)
	}
	f.host.pluginData = map[string]map[string]any{"textprobe": {"accounts": map[string]any{"format": 2, "value": []string{}}}}
	f.shell.Event("workspace-changed", nil)
	f.settle()
	reply := viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "accounts"})
	if message, _ := reply["error"].(map[string]any)["message"].(string); !strings.Contains(message, "plugin textprobe data accounts: stored format 2 is not declared format 1") {
		t.Fatalf("an entry of another format replied %v", reply)
	}
}
