package adapter

import (
	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// Workbench is the workbench of the mygo host, which draws in native UI and has no page (docs/spec/hosts.md#mygo-host). The
// framework adapter holds one Workbench, and the application passes it to Run.
type Workbench interface {
	// Prepared gives the workbench the host of the application before the first window exists.
	Prepared(h *host.Host)
	// Build builds the workbench of window and returns the view that draws it. The window asks for the view on the main thread.
	// Build runs when the window is created and again after Close when the workbench of the window starts again.
	Build(window host.Frontend) func(c *ui.Context)
	// Shown tells the workbench that the host holds window and started it, so the host answers the calls of that window. It runs once
	// for each Build of a window that the host holds.
	Shown(window host.Frontend)
	// Close ends the workbench of window, when the window closes or before its workbench starts again.
	Close(window host.Frontend)
	// Emit delivers an event to the workbench of window.
	Emit(window host.Frontend, name string, data ...any)
	// Call delivers a call of the workbench call channel to the workbench of window.
	Call(window host.Frontend, script string)
}
