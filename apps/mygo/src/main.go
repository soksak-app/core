// A mygo application that runs the soksak workbench in native UI.
//
// Staging places the view root in src/frontend/, and this file embeds that directory.
// Windows, surfaces, sidecars, and the local endpoint are handled by the Go language host library packages/host/go, and the mygo framework adapter packages/host/mygo runs it.
package main

import (
	"embed"
	"errors"
	"fmt"
	"os"

	"github.com/egoist/mygo"

	host "github.com/soksak-app/core/packages/host/go/src"
	adapter "github.com/soksak-app/core/packages/host/mygo/src"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
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
	mygoWorkbench, err := newWorkbench()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	host.ExitOnFailure(adapter.Run(assets, options, mygoWorkbench))
}

// newWorkbench makes the native workbench from the environment declaration of the staged assets.
func newWorkbench() (*workbenchPort, error) {
	environment, err := assets.ReadFile("frontend/environment.json")
	if err != nil {
		return nil, fmt.Errorf("environment declaration: %w", err)
	}
	return &workbenchPort{environment: environment}, nil
}

// workbenchPort connects the workbench of the application to the framework adapter, which knows the host once it prepared it.
type workbenchPort struct {
	environment []byte
	*workbench.App
}

// Prepared makes the workbench over the prepared host.
func (p *workbenchPort) Prepared(h *host.Host) {
	app, err := workbench.NewApp(workbench.AppOptions{
		Environment: p.environment,
		Post:        mygo.App.WhenReady,
		Table:       workbench.HostTable(h),
		Report:      func(line string) { host.LogError("workbench", errors.New(line)) },
		Installed:   h.InstalledPlugins,
		Element:     workbench.HostElement(h),
	})
	if err != nil {
		host.ExitOnFailure(err)
	}
	p.App = app
}
