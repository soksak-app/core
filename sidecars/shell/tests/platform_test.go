package shell_test

import (
	"testing"

	"github.com/min-median-max/soksak/sidecars/shell/src/platform"
	_ "github.com/min-median-max/soksak/sidecars/shell/src/shell"
)

func TestCurrentPlatformProvidesAShell(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	if current.Shell() == "" {
		t.Fatal("the platform returned an empty shell")
	}
}
