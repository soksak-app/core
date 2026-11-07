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

// showPlatform records the windows that the show of a framework passed to the registered platform.
type showPlatform struct {
	platform.Platform
	shown []platform.Window
}

func (p *showPlatform) ShowWindow(window platform.Window) error {
	p.shown = append(p.shown, window)
	return nil
}

// contract: application.window.show-reaches-the-registered-platform-before-the-host-starts
// The show of a framework window reaches the registered platform although no start of the host selected one, as in a process
// that configures the mygo application without starting the host (docs/spec/hosts.md#launch-activation).
func TestAWindowShowsThroughTheRegisteredPlatformBeforeTheHostStarts(t *testing.T) {
	previous := system
	system = nil
	t.Cleanup(func() { system = previous })
	fake := &showPlatform{}
	t.Cleanup(platform.Substitute(fake))
	window := platform.Window(1)
	ShowWindow(window)
	if len(fake.shown) != 1 || fake.shown[0] != window {
		t.Fatalf("the registered platform showed %v, want the one window %v", fake.shown, window)
	}
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
