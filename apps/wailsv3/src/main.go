// A Wails v3 application that runs the soksak workbench.
//
// Staging places the frontend in src/frontend/, and this file embeds that directory.
// Windows, surfaces, modals, sidecars, and the local endpoint are handled by the github.com/soksak-app/core/packages/host/wailsv3 package.
package main

import (
	"embed"
	"fmt"
	"os"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

//go:embed all:frontend
var assets embed.FS

func main() {
	// The arguments are read before the window opens. An invalid argument ends with status 2 (docs/spec/hosts.md#application-arguments).
	options, err := host.ParseArguments(os.Args[1:])
	if err == nil {
		err = host.ApplyArguments(options)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	host.ExitOnFailure(host.Run(assets, options))
}
