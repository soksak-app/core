package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// PluginsRunRequest is the argument of the pluginsRun call (docs/spec/installation.md#plugin-operations-in-the-application).
// Plugin is received without a fixed type so that a value that is not a string is rejected.
type PluginsRunRequest struct {
	Action string `json:"action"`
	Plugin any    `json:"plugin"`
}

// PluginsRegistryRequest is the argument of the pluginsUseRegistry call. Index is received without a fixed type so that a value that is not a string
// is rejected.
type PluginsRegistryRequest struct {
	Index any `json:"index"`
}

// PluginsStarterRequest is the argument of pluginsStarter.
type PluginsStarterRequest struct {
	State    string   `json:"state"`
	Pack     string   `json:"pack"`
	Registry string   `json:"registry"`
	Plugins  []string `json:"plugins"`
}

// PluginsChanged is the value of the plugins-changed event.
type PluginsChanged struct {
	Action string `json:"action"`
	Plugin string `json:"plugin"`
}

// errPluginOperationRunning is the rejection when another plugin operation is running.
var errPluginOperationRunning = errors.New("another plugin operation is running")

// Plugins converts the plugin installation of the configuration folder to the installer library of the command line.
// It runs one operation at a time, applies a change to the sidecars with apply and then notifies changed
// (docs/spec/installation.md#applying-a-change).
type Plugins struct {
	configDir string
	core      string
	platform  string
	running   sync.Mutex
	apply     func() error
	changed   func(PluginsChanged)
}

// NewPlugins creates a Plugins that works with the core version and the platform of this application.
func NewPlugins(configDir string, apply func() error, changed func(PluginsChanged)) (*Plugins, error) {
	platform, err := sok.CurrentPlatform()
	if err != nil {
		return nil, err
	}
	return &Plugins{configDir: configDir, core: sok.CoreVersion, platform: platform, apply: apply, changed: changed}, nil
}

// State returns the registry address, the index that was checked, and the install state.
func (p *Plugins) State() (*sok.PluginsState, error) {
	return sok.ReadPluginsState(p.configDir)
}

// Run runs an operation such as sok plugin <action> <plugin> and returns its output.
func (p *Plugins) Run(request PluginsRunRequest) (any, error) {
	switch request.Action {
	case "install", "update", "remove", "enable", "disable":
	default:
		return nil, fmt.Errorf("unknown plugin action %q", request.Action)
	}
	plugin, ok := request.Plugin.(string)
	if !ok || plugin == "" {
		return nil, errors.New("plugin must be a non-empty string")
	}
	if !p.running.TryLock() {
		return nil, errPluginOperationRunning
	}
	result, err := sok.RunPluginAction(p.configDir, request.Action, plugin, p.core, p.platform)
	if err != nil {
		p.running.Unlock()
		return nil, err
	}
	// installed.json changed, so the windows are notified also when the apply step fails; that failure is the error of
	// the operation.
	applied := p.apply()
	p.running.Unlock()
	p.changed(PluginsChanged{Action: request.Action, Plugin: plugin})
	if applied != nil {
		return nil, fmt.Errorf("apply %s %s: %w", request.Action, plugin, applied)
	}
	return result, nil
}

// UseRegistry sets the registry index as sok registry use <index> does and returns its output.
func (p *Plugins) UseRegistry(request PluginsRegistryRequest) (any, error) {
	index, ok := request.Index.(string)
	if !ok || index == "" {
		return nil, errors.New("index must be a non-empty string")
	}
	if !p.running.TryLock() {
		return nil, errPluginOperationRunning
	}
	url, err := sok.UseRegistry(p.configDir, index, sok.DefaultFetcher)
	p.running.Unlock()
	if err != nil {
		return nil, err
	}
	return map[string]string{"index": url}, nil
}

// SetStarter records or completes the durable starter job under the plugin-operation lock.
func (p *Plugins) SetStarter(request PluginsStarterRequest) (*sok.StarterJob, error) {
	if !p.running.TryLock() {
		return nil, errPluginOperationRunning
	}
	defer p.running.Unlock()
	return sok.WriteStarterJob(p.configDir, sok.StarterJobRequest{
		State: request.State, Pack: request.Pack, Registry: request.Registry, Plugins: request.Plugins,
	})
}

// PluginsState is the pluginsState call of the page.
func (h *Host) PluginsState() (*sok.PluginsState, error) {
	return h.plugins.State()
}

// PluginsRun is the pluginsRun call of the page.
func (h *Host) PluginsRun(requestJSON json.RawMessage) (any, error) {
	request, err := argument[PluginsRunRequest]("request", requestJSON)
	if err != nil {
		return nil, err
	}
	return h.plugins.Run(request)
}

// PluginsUseRegistry is the pluginsUseRegistry call of the page.
func (h *Host) PluginsUseRegistry(requestJSON json.RawMessage) (any, error) {
	request, err := argument[PluginsRegistryRequest]("request", requestJSON)
	if err != nil {
		return nil, err
	}
	return h.plugins.UseRegistry(request)
}

// PluginsStarter is the pluginsStarter call of the page.
func (h *Host) PluginsStarter(requestJSON json.RawMessage) (*sok.StarterJob, error) {
	request, err := argument[PluginsStarterRequest]("request", requestJSON)
	if err != nil {
		return nil, err
	}
	return h.plugins.SetStarter(request)
}

// notifySidecars sends sidecars-changed to every window (docs/spec/installation.md).
func (h *Host) notifySidecars() {
	h.mu.Lock()
	windows := make([]*Surfaces, 0, len(h.windows))
	for _, s := range h.windows {
		windows = append(windows, s)
	}
	h.mu.Unlock()
	for _, s := range windows {
		s.Emit("sidecars-changed")
	}
}

// notifyPlugins sends plugins-changed to all windows.
func (h *Host) notifyPlugins(change PluginsChanged) {
	h.mu.Lock()
	windows := make([]*Surfaces, 0, len(h.windows))
	for _, s := range h.windows {
		windows = append(windows, s)
	}
	h.mu.Unlock()
	h.pluginHostStates.pluginChanged(change.Action, change.Plugin)
	// The enable of a plugin clears its plugin host stop and the sidecar stops of its manifest in one step, as a surface open does.
	if change.Action == "enable" {
		h.pluginEnabled(change.Plugin)
	}
	for _, s := range windows {
		if change.Action == "remove" || change.Action == "disable" {
			// The host web view of the plugin ends with its removal or disable (docs/spec/plugin-host.md#lifetime).
			application.InvokeSync(func() { s.disposePluginHost(change.Plugin) })
		}
		s.Emit("plugins-changed", change)
	}
}
