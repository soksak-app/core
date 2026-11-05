package adapter_test

// Checks the framework port of the Wails framework adapter (docs/spec/hosts.md#mygo-host).

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/events"

	host "github.com/soksak-app/core/packages/host/go/src"
	adapter "github.com/soksak-app/core/packages/host/wailsv3/src"
)

var (
	_ host.Framework = adapter.Framework{}
	_ host.Frontend  = adapter.Frontend{}
)

// contract: application.framework.names-the-application
func TestTheWailsFrameworkNamesTheApplicationOfTheEndpoint(t *testing.T) {
	if name := (adapter.Framework{}).ApplicationName(); name != "wailsv3" {
		t.Fatalf("application name %q, want wailsv3", name)
	}
	if name := (adapter.Framework{}).DisplayName(); name != "Wails v3" {
		t.Fatalf("display name %q, want Wails v3", name)
	}
}

// The port gives logical lengths as float64 and Wails holds integers, so the adapter takes the nearest integer.
// contract: application.framework.lengths-are-logical-pixels
func TestALogicalLengthOfThePortIsTheNearestIntegerOfWails(t *testing.T) {
	for length, want := range map[float64]int{1200: 1200, 1200.4: 1200, 1200.5: 1201, -10.6: -11} {
		if got := adapter.WailsPixels(length); got != want {
			t.Errorf("%v is %d pixels of Wails, want %d", length, got, want)
		}
	}
}

// contract: application.framework.window-events-are-port-events
func TestEachWindowEventOfTheFrontendIsAnEventOfWails(t *testing.T) {
	for event, want := range map[host.WindowEvent]events.WindowEventType{
		host.WindowResize:             events.Common.WindowDidResize,
		host.WindowMove:               events.Common.WindowDidMove,
		host.WindowFocus:              events.Common.WindowFocus,
		host.WindowFocusLost:          events.Common.WindowLostFocus,
		host.WindowShow:               events.Common.WindowShow,
		host.WindowHide:               events.Common.WindowHide,
		host.WindowScaleChanged:       events.Mac.WindowDidChangeBackingProperties,
		host.WindowWorkbenchEnded:     events.Mac.WebViewWebContentProcessDidTerminate,
		host.WindowWorkbenchCommitted: events.Mac.WebViewDidCommitNavigation,
	} {
		if got := adapter.WailsWindowEvent(event); got != want {
			t.Errorf("window event %d is the Wails event %d, want %d", event, got, want)
		}
	}
}
