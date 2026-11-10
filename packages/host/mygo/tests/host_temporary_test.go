package adapter_test

// Checks the temporary folder that a test gives a host that it starts in its own process (docs/operations/examples.md#temporary-folders).

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/mygo/tests/support"
)

// The host keeps its socket folder in the temporary folder across its runs, so a host that a test starts in the test process makes
// that folder in a short folder of its own, which ends with the host and leaves the temporary folder of the process as it was.
func TestAHostInTheTestProcessMakesItsSocketFolderInAFolderThatEndsWithIt(t *testing.T) {
	previous, set := os.LookupEnv("TMPDIR")
	end, err := support.HostTemporary()
	if err != nil {
		t.Fatal(err)
	}
	folder := os.Getenv("TMPDIR")
	if !strings.HasPrefix(host.SocketDirectory(), filepath.Clean(folder)+string(filepath.Separator)) {
		t.Fatalf("the socket folder %s is not in the folder %s of the host", host.SocketDirectory(), folder)
	}
	if err := os.MkdirAll(host.SocketDirectory(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := end(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(folder); !os.IsNotExist(err) {
		t.Fatalf("the folder %s of the host remains: %v", folder, err)
	}
	now, nowSet := os.LookupEnv("TMPDIR")
	if now != previous || nowSet != set {
		t.Fatalf("TMPDIR is %q (set %v) after the end, want %q (set %v)", now, nowSet, previous, set)
	}
}
