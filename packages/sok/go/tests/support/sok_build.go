package support

// The build of the sok executable that the tests of the agent and setup commands run (docs/spec/hosts.md difference C17).

import (
	"errors"
	"os/exec"
	"runtime/debug"
)

// SokBuild returns the command that builds the sok executable of this package into program with the go tool at goTool. The build
// tags select the files of a build, and the identifier and the diagnostic commands of sok depend on them (src/dev.go,
// src/mygo.go, src/diagnostics.go), so the command builds with the -tags setting that go test recorded in the build information
// of the running test binary: the sok that a test runs is the build whose package the test checks.
func SokBuild(goTool, program string) (*exec.Cmd, error) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return nil, errors.New("the test binary holds no build information")
	}
	// go test records no -tags setting for a build without tags.
	tags := ""
	for _, setting := range info.Settings {
		if setting.Key == "-tags" {
			tags = setting.Value
		}
	}
	return exec.Command(goTool, "build", "-tags", tags, "-o", program, "github.com/soksak-app/core/packages/sok/go/src/cmd/sok"), nil
}
