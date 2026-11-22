// A view follows the declared statuses of a plugin that its plugin lists in dependencies, on a shell of the native workbench
// (docs/spec/native-surfaces.md#view-surfaces, docs/spec/plugins.md#pluginjson).
package workbench_test

import (
	"strings"
	"testing"
)

// A view follows the declared statuses of a plugin that its plugin lists in dependencies, and no other status of that plugin.
func TestAViewFollowsAStatusOfADependency(t *testing.T) {
	document := strings.Replace(installedDocument, `"dependencies": {"@scope/sidecar-probe": "^1.0.0"}`, `"dependencies": {"@scope/sidecar-probe": "^1.0.0", "boxprobe": "^1.0.0"}`, 1)
	document = strings.Replace(document, `"surface": {"composition": {"kind": "view", "page": "ui/index.html"}}, "sections"`, `"exposes": {"status": [{"name": "boxprobe.page", "description": "the page", "schema": {"type": "string"}}]}, "surface": {"composition": {"kind": "view", "page": "ui/index.html"}}, "sections"`, 1)
	r := newViewRelayWith(t, &surfaceHost{}, document)
	surface := r.surface()
	reply := viewCall(t, r.f, r.stored, surface, "runtime.status.watch", map[string]any{"name": "boxprobe.page"})
	if reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
	reply = viewCall(t, r.f, r.stored, surface, "runtime.status.watch", map[string]any{"name": "boxprobe.other"})
	if failure, _ := reply["error"].(map[string]any); failure == nil || failure["message"] != "view call runtime.status.watch boxprobe.other is not a declared status" {
		t.Fatalf("the reply is %v", reply)
	}
}
