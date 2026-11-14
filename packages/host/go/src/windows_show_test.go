package host

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// showWithoutHostChild marks the child process that shows a window with no registered platform.
const showWithoutHostChild = "SOKSAK_SHOW_WITHOUT_HOST_CHILD"

// contract: application.window.show-reaches-the-registered-platform-before-the-host-starts
// The show of a framework window reaches the registered platform although no start of the host selected one, as in a process
// that configures the mygo application without starting the host (docs/spec/hosts.md#launch-activation). The registered platform
// is the native platform, which shows no window that does not exist, so the show of window 0 returns, and a host that read the
// platform of its start (nil here) would end in a nil dereference.
func TestAWindowShowsThroughTheRegisteredPlatformBeforeTheHostStarts(t *testing.T) {
	previous := system
	system = nil
	t.Cleanup(func() { system = previous })
	if _, err := platform.Current(); err != nil {
		t.Fatalf("the native platform is not registered: %v", err)
	}
	runOnMainThread(func() { ShowWindow(platform.Window(0)) })
}

// contract: application.window.show-without-a-registered-platform-ends-through-the-fatal-error
// A show with no registered platform ends the process with status 1 through the fatal error of the host instead of a panic.
// Without a registration no event log opens, so the child shows the window with no log attached.
func TestAWindowShowWithoutARegisteredPlatformEndsTheProcessThroughTheFatalError(t *testing.T) {
	const returned = "the show returned with no registered platform"
	if os.Getenv(showWithoutHostChild) != "" {
		system = nil
		platform.Substitute(nil)
		ShowWindow(platform.Window(1))
		t.Fatal(returned)
	}
	command := exec.Command(os.Args[0], "-test.run", "^TestAWindowShowWithoutARegisteredPlatformEndsTheProcessThroughTheFatalError$", "-test.count=1")
	command.Env = append(os.Environ(), showWithoutHostChild+"=1")
	output, err := command.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 || strings.Contains(string(output), "panic:") || strings.Contains(string(output), returned) {
		t.Fatalf("the child ended with %v, want exit status 1 from the fatal error without a panic: %s", err, output)
	}
}
