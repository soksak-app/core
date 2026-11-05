package adapter_test

// Checks the launch activation of the application (docs/spec/hosts.md#launch-activation).

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	adapter "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: application.launch.system-decides-activation
func TestTheApplicationLeavesTheLaunchActivationToTheSystem(t *testing.T) {
	options := adapter.LaunchMacOptions()
	if options.ActivationPolicy != application.ActivationPolicyRegular {
		t.Fatalf("activation policy %d, want regular", options.ActivationPolicy)
	}
	if !options.DisableActivationOnLaunch {
		t.Fatal("the application activates itself when it finishes launching, so a launch that requested no activation takes the focus")
	}
}

// contract: application.window.opens-without-taking-the-front
func TestAWindowShowsThroughTheShowOfTheHost(t *testing.T) {
	if adapter.LaunchMacOptions().WindowShow == nil {
		t.Fatal("a shown window comes to the front while another application is active")
	}
}
