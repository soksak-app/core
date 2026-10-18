package host_test

// Checks the launch activation of the application (docs/spec/hosts.md#launch-activation).

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: application.launch.system-decides-activation
func TestTheApplicationLeavesTheLaunchActivationToTheSystem(t *testing.T) {
	options := host.LaunchMacOptions()
	if options.ActivationPolicy != application.ActivationPolicyRegular {
		t.Fatalf("activation policy %d, want regular", options.ActivationPolicy)
	}
	if !options.DisableActivationOnLaunch {
		t.Fatal("the application activates itself when it finishes launching, so a launch that requested no activation takes the focus")
	}
}
