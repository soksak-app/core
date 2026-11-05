package adapter_test

// Checks that the application does not activate itself when it finishes launching (docs/spec/hosts.md#launch-activation). The child
// shows no window, so a run of this test takes no focus while it holds.

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo"

	adapter "github.com/soksak-app/core/packages/host/mygo/src"
)

// selfActivationHelper names the child process of the test.
const selfActivationHelper = "SOKSAK_MYGO_SELF_ACTIVATION_HELPER"

func init() { helpers[selfActivationHelper] = runSelfActivationHelper }

// runSelfActivationHelper finishes launching, keeps running for a second, in which an activation of its own arrives, and reports it.
func runSelfActivationHelper() {
	adapter.ConfigureApplication()
	var activated atomic.Bool
	mygo.App.OnDidBecomeActive(func() { activated.Store(true) })
	framework := adapter.NewFramework(&sceneWorkbench{})
	mygo.App.WhenReady(func() {
		go func() {
			time.Sleep(time.Second)
			fmt.Println("active", mygo.App.IsActive() || activated.Load())
			framework.Quit()
		}()
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "the application did not run:", err)
		os.Exit(1)
	}
}

// contract: application.launch.system-decides-activation
func TestTheApplicationDoesNotActivateItselfWhenItFinishesLaunching(t *testing.T) {
	child := exec.Command(os.Args[0])
	child.Env = append(os.Environ(), selfActivationHelper+"=1")
	output, err := child.CombinedOutput()
	if err != nil {
		t.Fatalf("the child failed: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "active false\n") {
		t.Fatalf("the child reported %q, want active false", output)
	}
}
