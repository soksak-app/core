//go:build linux

package linux

import (
	"os"
	"strconv"
	"strings"
	"testing"

	_ "github.com/soksak-app/core/packages/sok/go/src/platform/linux"
	"github.com/soksak-app/core/packages/sok/go/tests/support"
)

// contract: cli.process-wait.unsupported-on-linux
func TestProcessWaitReportsUnsupportedPlatform(t *testing.T) {
	code, stdout, stderr := support.RunProcessWait("process", "wait", strconv.Itoa(os.Getpid()))
	if code != 1 || stdout != "" || !strings.Contains(stderr, "waiting for a process end is not implemented on linux") {
		t.Fatalf("unsupported process wait returned code=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}
