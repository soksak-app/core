//go:build windows

package windows

import (
	"os"
	"strconv"
	"strings"
	"testing"

	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/windows"
	"github.com/soksak-app/core/packages/sok/wailsv3/tests/support"
)

// contract: cli.process-wait.unsupported-on-windows
func TestProcessWaitReportsUnsupportedPlatform(t *testing.T) {
	code, stdout, stderr := support.RunProcessWait("process", "wait", strconv.Itoa(os.Getpid()), "--timeout-ms", "1")
	if code != 1 || stdout != "" || !strings.Contains(stderr, "waiting for a process end is not implemented on windows") {
		t.Fatalf("unsupported process wait returned code=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}
