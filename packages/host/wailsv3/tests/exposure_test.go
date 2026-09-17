package host_test

import (
	"encoding/json"
	"testing"
)

func TestExposureListAppendsHostEntries(t *testing.T) {
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	got := call(t, conn, 1, "exposure.list", map[string]any{"window": "main"})
	var list struct {
		Status []struct {
			Name       string
			Registered bool
		}
		Commands []struct {
			Name       string
			Registered bool
		}
	}
	if err := json.Unmarshal(got.Result, &list); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, entry := range append(list.Status, list.Commands...) {
		names[entry.Name] = entry.Registered
	}
	for _, name := range []string{"core.layout", "host.window", "host.screens", "host.dock", "host.window.close", "host.window.move", "host.dock.select", "host.hit", "host.quit"} {
		if !names[name] {
			t.Fatalf("%s is missing or unregistered in %s", name, got.Result)
		}
	}
}
