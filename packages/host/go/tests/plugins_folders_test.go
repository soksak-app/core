package host_test

// Checks the count of the plugin folders that the host watches (docs/spec/installation.md#plugin-folders).

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// contract: plugins.folders.count-follows-a-folder-added-or-removed
func TestPluginFolderCountFollowsAFolderAddedOrRemoved(t *testing.T) {
	config := t.TempDir()
	if err := os.Mkdir(filepath.Join(config, "plugins"), 0o755); err != nil {
		t.Fatal(err)
	}
	plugins, _ := support.NewPlugins(t, config)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	counts := make(chan int, 8)
	if err := plugins.WatchFolders(ctx, func(count int) { counts <- count }); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(config, "plugins", "probe")
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	expectCount(t, counts, 1)
	if err := os.Remove(folder); err != nil {
		t.Fatal(err)
	}
	expectCount(t, counts, 0)
}

func expectCount(t *testing.T, counts <-chan int, want int) {
	t.Helper()
	select {
	case got := <-counts:
		if got != want {
			t.Fatalf("folder count %d, want %d", got, want)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("no folder count %d within 10 s", want)
	}
}
