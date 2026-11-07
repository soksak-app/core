//go:build darwin

package darwin

import (
	"github.com/egoist/mygo"

	"github.com/soksak-app/core/packages/host/go/src/platform/darwin"
)

// The functions are installed before any start of the library (docs/spec/hosts.md, main thread of the Wails host).
func init() {
	darwin.InstallMainThread(mygo.RunOnWorkerAddress(), mygo.RunOnMainAddress())
}
