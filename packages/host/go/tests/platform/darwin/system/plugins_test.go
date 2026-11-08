//go:build darwin

package system_test

import (
	"os"
	"syscall"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// contract: plugins.run.rejects-invalid-and-concurrent
func TestPluginsRunRejectsInvalidAndConcurrentOperations(t *testing.T) {
	config := t.TempDir()
	index, release := support.PluginRegistry(t)
	if _, err := sok.UseRegistry(config, index, sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	plugins, seen := support.NewPlugins(t, config)
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
	// When the release is replaced by a FIFO, the installation stops while it reads that FIFO. At the moment the FIFO is opened for writing, the installation is running.
	data, err := os.ReadFile(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(release); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(release, 0o644); err != nil {
		t.Fatal(err)
	}
	first := make(chan error, 1)
	go func() {
		_, err := plugins.Run(host.PluginsRunRequest{Action: "install", Plugin: "probe"})
		first <- err
	}()
	writer, err := os.OpenFile(release, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := plugins.Run(host.PluginsRunRequest{Action: "install", Plugin: "probe"}); err == nil || err.Error() != "another plugin operation is running" {
		t.Fatalf("concurrent install: %v", err)
	}
	if len(seen.List()) != 0 {
		t.Fatalf("rejected operations sent %+v", seen.List())
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
	if got := seen.List(); len(got) != 1 || got[0] != (host.PluginsChanged{Action: "install", Plugin: "probe"}) {
		t.Fatalf("plugins-changed %+v", got)
	}
}
