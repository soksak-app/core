package host_test

import (
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: page.process.termination-writes-an-error-line
func TestThePageProcessEndIsAnErrorLine(t *testing.T) {
	place, text, reported := host.PageProcessEnded("main", false)
	if line := host.ErrorLine(place, text); !reported || line != "error: page process: main: terminated" {
		t.Fatalf("line %q, reported %v", line, reported)
	}
	// The host ends the process on purpose while it quits.
	if _, _, reported := host.PageProcessEnded("main", true); reported {
		t.Fatal("the end of a page process while the host quits was reported")
	}
}
