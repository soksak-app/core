package host

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// contract: plugin-host.starter.rejects-invalid-request
func TestPluginsStarterIsExposedThroughTheBindingEntrance(t *testing.T) {
	bindings, err := NewBindings(&Host{plugins: &Plugins{}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = bindings.Call(context.Background(), "PluginsStarter", []json.RawMessage{json.RawMessage(`{"state":3}`)}, nil)
	if err == nil || !strings.Contains(err.Error(), "argument request.state must be a string") {
		t.Fatalf("invalid starter command argument: %v", err)
	}
}
