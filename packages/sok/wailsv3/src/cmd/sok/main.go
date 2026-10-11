// sok is the command line of the Wails application (docs/spec/cli.md).
package main

import (
	"fmt"
	"os"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/linux"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/windows"
)

func main() {
	system, err := platform.Current()
	if err != nil {
		fmt.Fprintf(os.Stderr, "sok: %v\n", err)
		os.Exit(1)
	}
	paths, pathsErr := system.PathsDir()
	// The identifier names the default configuration directory and the path entry (docs/spec/projects.md#persistence).
	identifier := sok.Identity()
	os.Exit(sok.Main(os.Args[1:], os.Stdout, os.Stderr, sok.Options{Identifier: identifier, PathsDir: paths, PathsError: pathsErr, CoreVersion: sok.CoreVersion}))
}
