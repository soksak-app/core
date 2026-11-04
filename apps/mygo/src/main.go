// A mygo application that runs the soksak workbench in native UI.
//
// Staging places the view root in src/frontend/, and this file embeds that directory.
// Windows, surfaces, sidecars, and the local endpoint are handled by the Go language host library packages/host/go, and the mygo framework adapter packages/host/mygo runs it.
package main

import (
	"embed"
	"fmt"
	"os"

	host "github.com/soksak-app/core/packages/host/go/src"
	adapter "github.com/soksak-app/core/packages/host/mygo/src"
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
	host.ExitOnFailure(adapter.Run(assets, options, nil))
}
