//go:build diagnostics

// The watch of the policy file holds the file before it reads it (docs/spec/logging.md#classes-and-policy): a write in place
// that lands right after the creation gives a notification of its own, or the read that follows the watch sees it.
package host_test

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: log.policy.event-reaches-every-document
func TestACreatedPolicyFileIsWatchedBeforeItsRead(t *testing.T) {
	config := t.TempDir()
	options := eventLogOptions(filepath.Join(config, "logs"))
	options.PolicyPath = filepath.Join(config, "log-policy.json")
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	reads := make(chan []string, 16)
	host.SetLogPolicyWatchHook(func(watched []string) { reads <- watched })
	t.Cleanup(func() { host.SetLogPolicyWatchHook(nil) })
	stop, err := host.StartLogPolicy(log, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(stop)
	if err := os.WriteFile(options.PolicyPath, []byte(`{"schema":9}`), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case watched := <-reads:
		if !slices.Contains(watched, options.PolicyPath) {
			t.Fatalf("the read of the created policy file started while the watch held %v, without the file", watched)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no notification of the created policy file within 10 seconds")
	}
}
