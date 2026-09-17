package shell_test

import (
	"testing"

	"github.com/min-median-max/soksak/sidecars/shell/src/platform"
	_ "github.com/min-median-max/soksak/sidecars/shell/src/shell"
)

func TestCurrentPlatformBuildsASession(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	cmd, err := current.Session()
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Path == "" {
		t.Fatal("the platform returned a session without a program")
	}
}

func TestAPosixShellIsUsedWhenShellIsNotPosix(t *testing.T) {
	t.Setenv("SHELL", "/opt/homebrew/bin/fish")
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	cmd, err := current.Session()
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Path != "/bin/sh" {
		t.Fatalf("session program = %s, want /bin/sh", cmd.Path)
	}
}
