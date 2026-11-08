//go:build darwin

package system_test

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// lockedBackend is the backend of an endpoint whose start is refused at the process lock: the start fails before it asks anything of
// the backend, so a call of a method panics on the missing interface value.
type lockedBackend struct{ host.Backend }

// contract: endpoint.process.rejects-a-malformed-lock
func TestEndpointRefusesAHeldLockWithAnotherForm(t *testing.T) {
	for _, contents := range []string{"123", "abc", "0", "-3", "", `{"pid":0,"boot":"b1"}`, `{"pid":5}`} {
		config := t.TempDir()
		lock := filepath.Join(config, "process.lock")
		if err := os.WriteFile(lock, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
		// This test is the live owner: it holds the lock while the content has another form.
		owner, err := os.Open(lock)
		if err != nil {
			t.Fatal(err)
		}
		if err := syscall.Flock(int(owner.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			t.Fatal(err)
		}
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		endpoint := host.NewEndpoint(lockedBackend{})
		info := host.EndpointInfo{Transport: "tcp", Address: listener.Addr().String(), PID: os.Getpid(),
			Application: "fixture", Version: "0.0.8", Started: time.Now()}
		err = endpoint.Serve(listener, info, config)
		_ = listener.Close()
		want := fmt.Sprintf("configuration directory %s is already owned by a live process", config)
		if err == nil || !strings.HasPrefix(err.Error(), want) {
			t.Fatalf("held lock %q: %v, want prefix %q", contents, err, want)
		}
		if data, err := os.ReadFile(lock); err != nil || string(data) != contents {
			t.Fatalf("lock %q changed: %q %v", contents, data, err)
		}
		_ = owner.Close()
	}
}
