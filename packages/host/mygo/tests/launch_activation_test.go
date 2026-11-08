//go:build e2e

package adapter_test

// Checks the launch activation of the application (docs/spec/hosts.md#launch-activation) in a child process with the regular
// activation policy of the host: the application shows a window and is not the active application until a focus request.

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo"

	host "github.com/soksak-app/core/packages/host/go/src"
	adapter "github.com/soksak-app/core/packages/host/mygo/src"
	"github.com/soksak-app/core/packages/host/mygo/tests/support"
)

// launchHelper names the child process of the launch test.
const launchHelper = "SOKSAK_MYGO_LAUNCH_HELPER"

func init() { helpers[launchHelper] = runLaunchHelper }

// runLaunchHelper shows a window of the fixture workbench, keeps it for a second, in which an activation arrives, and reports.
func runLaunchHelper() {
	adapter.ConfigureApplication()
	var activated atomic.Bool
	mygo.App.OnDidBecomeActive(func() { activated.Store(true) })
	framework := adapter.NewFramework(&support.SceneWorkbench{})
	mygo.App.WhenReady(func() {
		go func() {
			window := framework.NewWindow(host.WindowOptions{Name: "launch", Title: "soksak", Width: 400, Height: 300}).(*adapter.Frontend)
			window.Show()
			for limit := time.Now().Add(10 * time.Second); !window.Window().IsVisible() && time.Now().Before(limit); time.Sleep(5 * time.Millisecond) {
			}
			fmt.Println("visible", window.Window().IsVisible())
			time.Sleep(time.Second)
			fmt.Println("active", mygo.App.IsActive() || activated.Load())
			// Focus is a request of the person, the one step that activates the application.
			window.Focus()
			for limit := time.Now().Add(10 * time.Second); !window.IsFocused() && time.Now().Before(limit); time.Sleep(5 * time.Millisecond) {
			}
			fmt.Println("focused", window.IsFocused())
			framework.Quit()
		}()
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "the application did not run:", err)
		os.Exit(1)
	}
}

// contract: application.launch.system-decides-activation
func TestE2ETheApplicationLeavesTheLaunchActivationToTheSystem(t *testing.T) {
	child := exec.Command(os.Args[0])
	child.Env = append(os.Environ(), launchHelper+"=1")
	output, err := child.CombinedOutput()
	if err != nil {
		t.Fatalf("the child failed: %v\n%s", err, output)
	}
	if want := "visible true\nactive false\nfocused true\n"; !strings.Contains(string(output), want) {
		t.Fatalf("the child reported %q, want %q", output, want)
	}
}
