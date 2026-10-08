package host_test

import (
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: page.process.termination-writes-an-error-line
func TestThePageProcessEndIsAnErrorLine(t *testing.T) {
	place, text := host.PageProcessEnded("main")
	if line := host.ErrorLine(place, text); line != "error: page process: main: terminated" {
		t.Fatalf("line %q", line)
	}
}
