// sok is the command line of the Wails application (docs/spec/cli.md).
package main

import (
	"fmt"
	"os"

	"github.com/soksak-app/core/packages/sok/go/src"
	"github.com/soksak-app/core/packages/sok/go/src/platform"
	_ "github.com/soksak-app/core/packages/sok/go/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/sok/go/src/platform/linux"
	_ "github.com/soksak-app/core/packages/sok/go/src/platform/windows"
)

func main() {
	if _, err := platform.Current(); err != nil {
		fmt.Fprintf(os.Stderr, "sok: %v\n", err)
		os.Exit(1)
	}
	// The identifier names the default configuration directory (docs/spec/projects.md#persistence).
	identifier := sok.Identity()
	os.Exit(sok.Main(os.Args[1:], os.Stdout, os.Stderr, sok.Options{Identifier: identifier, CoreVersion: sok.CoreVersion}))
}
