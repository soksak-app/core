package workbench_test

// A view reads and follows the project data of a plugin that its plugin lists in dependencies, and no other (docs/spec/plugins.md#project-data).

import (
	"encoding/json"
	"strings"
	"testing"
)

// dependencyDocument lists the package @scope/plugin-boxprobe of the plugin boxprobe in the dependencies of textprobe, and declares the key note of boxprobe.
func dependencyDocument() string {
	document := strings.Replace(installedDocument, `"dependencies": {"@scope/sidecar-probe": "^1.0.0"}`, `"dependencies": {"@scope/sidecar-probe": "^1.0.0", "@scope/plugin-boxprobe": "^1.0.0"}`, 1)
	return strings.Replace(document, `"manifest": {"id": "boxprobe", `, `"manifest": {"id": "boxprobe", "data": {"note": {"schema": {"type": "string"}, "default": "none"}}, `, 1)
}

// storeBoxNote stores the JSON text of the key note of boxprobe for the project, as the store answers it, and lets the window read it.
func storeBoxNote(f *shellFixture, stored *surfaceHost, text string) {
	stored.projects[0]["plugins"] = map[string]any{"boxprobe": map[string]any{"note": map[string]any{"format": 1, "value": json.RawMessage(text)}}}
	f.shell.Event("workspace-changed", nil)
	f.settle()
}

// viewEventKeys returns the keys of the view events of the name that surface received.
func viewEventKeys(t *testing.T, stored *surfaceHost, surface, name string) []string {
	t.Helper()
	keys := []string{}
	for _, line := range stored.hostName {
		text, found := strings.CutPrefix(line, "viewEvent ")
		if !found {
			continue
		}
		var event struct {
			Surface string `json:"surface"`
			Event   string `json:"event"`
			Data    struct {
				Key string `json:"key"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(text), &event); err != nil {
			t.Fatal(err)
		}
		if event.Surface == surface && event.Event == name {
			keys = append(keys, event.Data.Key)
		}
	}
	return keys
}

// contract: project-data.dependency.reads-and-follows
func TestAViewReadsAndFollowsTheProjectDataOfADependency(t *testing.T) {
	f, stored := surfaceShellOf(t, dependencyDocument())
	surface := terminalSurface(t, stored)
	storeBoxNote(f, stored, `"from box"`)
	if reply := viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "note", "plugin": "boxprobe"}); reply["result"] != "from box" {
		t.Fatalf("the read of the dependency answers %v", reply)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.data.on", map[string]any{"plugin": "boxprobe"}); reply["error"] != nil {
		t.Fatalf("the subscription to the dependency is refused: %v", reply)
	}
	storeBoxNote(f, stored, `"moved"`)
	if keys := viewEventKeys(t, stored, surface, "data:boxprobe"); len(keys) != 1 || keys[0] != "note" {
		t.Fatalf("the events of the dependency are %v, want the key note once", keys)
	}
	if keys := viewEventKeys(t, stored, surface, "data"); len(keys) != 0 {
		t.Fatalf("a change of the dependency reaches the own data event: %v", keys)
	}
}

// contract: project-data.dependency.refusals
func TestAViewIsRefusedAChangeOfADependencyAndAReadOfAPluginThatIsNoDependency(t *testing.T) {
	f, stored := surfaceShellOf(t, dependencyDocument())
	surface := terminalSurface(t, stored)
	storeBoxNote(f, stored, `"from box"`)
	if got := failure(t, viewCall(t, f, stored, surface, "runtime.data.set", map[string]any{"key": "note", "value": "x", "plugin": "boxprobe"})); got != "view call runtime.data.set boxprobe is read-only for textprobe: a view changes only the project data of its own plugin" {
		t.Fatalf("the write of the dependency is refused with %q", got)
	}
	if got := failure(t, viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "note", "plugin": "other"})); got != "view call runtime.data.get other is not a dependency of textprobe" {
		t.Fatalf("the read of a plugin that is no dependency is refused with %q", got)
	}
	if got := failure(t, viewCall(t, f, stored, surface, "runtime.data.on", map[string]any{"plugin": "textprobe"})); got != "view call runtime.data.on textprobe is not a dependency of textprobe" {
		t.Fatalf("the subscription to the plugin itself is refused with %q", got)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "note", "plugin": "boxprobe"}); reply["result"] != "from box" {
		t.Fatalf("a refused write changed the dependency: %v", reply)
	}
}
