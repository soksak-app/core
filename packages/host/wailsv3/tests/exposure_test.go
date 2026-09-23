package host_test

import (
	"encoding/json"
	"testing"
	"time"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

// contract: exposure.list.appends-host-entries-registered
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
	for _, name := range []string{"core.layout", "host.window", "host.windows", "host.screens", "host.dock", "host.window.close", "host.window.fullscreen", "host.window.move", "host.dock.select", "host.hit", "host.quit"} {
		if !names[name] {
			t.Fatalf("%s is missing or unregistered in %s", name, got.Result)
		}
	}
}

// contract: exposure.timeout.command-run-default-and-declared, exposure.timeout.status-next-unbounded, exposure.timeout.invalid-timeout-rejected, exposure.timeout.status-next-timeout-rejected
func TestForwardedRequestsUseTheDeclaredTimeout(t *testing.T) {
	cases := []struct {
		method, timeout string
		want            time.Duration
	}{
		{"command.run", "", 10 * time.Second},
		{"command.run", "600000", 600 * time.Second},
		{"command.run", "1", time.Millisecond},
		{"status.next", "", 0},
	}
	for _, c := range cases {
		got, invalid := host.ForwardTimeout(c.method, json.RawMessage(c.timeout))
		if invalid != nil || got != c.want {
			t.Fatalf("%s %q: %v %v, want %v", c.method, c.timeout, got, invalid, c.want)
		}
	}
	for _, timeout := range []string{"0", "600001", "1.5", `"10"`, "-1"} {
		if _, invalid := host.ForwardTimeout("command.run", json.RawMessage(timeout)); invalid == nil || invalid.Code != -32602 {
			t.Fatalf("timeout %s: %v", timeout, invalid)
		}
	}
	if _, invalid := host.ForwardTimeout("status.next", json.RawMessage("10")); invalid == nil || invalid.Code != -32602 {
		t.Fatalf("status.next accepted a timeout: %v", invalid)
	}
}
