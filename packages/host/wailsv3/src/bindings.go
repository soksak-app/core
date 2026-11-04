package adapter

// The bound type of the Wails binding service (docs/spec/hosts.md#mygo-host): the name of the service is the package path of this
// file and the name of the type, so the generated page bindings keep calling it.

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// bindingService is the name of the Wails binding service of Bindings.
const bindingService = "github.com/soksak-app/core/packages/host/wailsv3/src.Bindings"

// Bindings passes each call of a page to the bindings of the language host library.
type Bindings struct {
	bindings *host.Bindings
}

// NewBindings returns the bound type of the host calls of target.
func NewBindings(target any) (*Bindings, error) {
	bindings, err := host.NewBindings(target, bindingService)
	if err != nil {
		return nil, fmt.Errorf("host calls: %w", err)
	}
	return &Bindings{bindings: bindings}, nil
}

// Call runs the method `method` of the host for the window of the call, with the correlation identifiers cids of the operation that
// the call carries out.
func (b *Bindings) Call(ctx context.Context, method string, args []json.RawMessage, cids []string) (any, error) {
	if window, ok := ctx.Value(application.WindowKey).(*application.WebviewWindow); ok {
		ctx = host.WithFrontend(ctx, Frontend{window: window})
	}
	return b.bindings.Call(ctx, method, args, cids)
}
