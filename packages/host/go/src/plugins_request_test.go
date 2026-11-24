package host

import (
	"encoding/json"
	"testing"
)

// contract: plugins.run.end-is-optional
//
// The workbench sends pluginsRun {action, plugin} without end for an operation that ends no service
// (docs/spec/installation.md#plugin-operations-in-the-application), so the request decodes without end, and end is absent.
func TestPluginsRunRequestDecodesWithoutEnd(t *testing.T) {
	for _, raw := range []string{`{"action":"update","plugin":"agents"}`, `{"action":"update","plugin":"agents","end":null}`} {
		request, err := argument[PluginsRunRequest]("request", json.RawMessage(raw))
		if err != nil {
			t.Fatalf("pluginsRun %s: %v, want a request without end", raw, err)
		}
		if request.End != nil {
			t.Fatalf("pluginsRun %s: end = %v, want nil", raw, request.End)
		}
	}
	request, err := argument[PluginsRunRequest]("request", json.RawMessage(`{"action":"update","plugin":"agents","end":true}`))
	if err != nil || request.End != true {
		t.Fatalf("pluginsRun with end true: end = %v, err = %v, want true", request.End, err)
	}
}
