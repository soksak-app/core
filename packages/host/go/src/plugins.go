package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"sync"
	"sync/atomic"

	"github.com/soksak-app/core/packages/host/go/src/routine"
	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// PluginsRunRequest is the argument of the pluginsRun call (docs/spec/installation.md#plugin-operations-in-the-application).
// Plugin is received without a fixed type so that a value that is not a string is rejected.
// End is received without a fixed type so that a value other than true is rejected.
type PluginsRunRequest struct {
	Action string `json:"action"`
	Plugin any    `json:"plugin"`
	End    any    `json:"end"`
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

// PluginServices is what a plugin operation reads and ends of the persistent services of the host
// (docs/spec/persistent-services.md#updates). Sidecars implements it.
type PluginServices interface {
	BeginPluginOperation()
	EndPluginOperation()
	RunningServices() (sok.Services, error)
	HeldServices(held sok.Held) ([]sok.HeldService, bool)
	EndServices(ctx context.Context, held sok.Held) error
}

// heldEntry is the latest held operation of a plugin: its action and the hold that the installer gave.
type heldEntry struct {
	action string
	held   sok.Held
}

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
	// services returns the persistent services of the host, nil while the host has no sidecars.
	services func() PluginServices
	// stopped is set when the shutdown of the host begins; the update at start checks it before each step that changes the installation.
	stopped atomic.Bool
	// startFailures holds the failures of the update at start, which pluginsState reports (docs/spec/installation.md#update-at-start).
	startMu       sync.Mutex
	startFailures []sok.StartFailure
	// held holds the latest held operation of each plugin; startMu protects it.
	held map[string]heldEntry
}

// NewPlugins creates a Plugins that works with the core version and the platform of this application. services returns the
// persistent services of the host, or nil while it has none.
func NewPlugins(configDir string, services func() PluginServices, apply func() error, changed func(PluginsChanged)) (*Plugins, error) {
	platform, err := sok.CurrentPlatform()
	if err != nil {
		return nil, err
	}
	return &Plugins{configDir: configDir, core: sok.CoreVersion, platform: platform, services: services, apply: apply, changed: changed,
		held: map[string]heldEntry{}}, nil
}

// State returns the registry address, the index that was checked, the install state, the failures of the update at start and the
// held operations. A held operation whose services no longer hold it is dropped (docs/spec/persistent-services.md#updates).
func (p *Plugins) State() (*sok.PluginsState, error) {
	state, err := sok.ReadPluginsState(p.configDir, p.core)
	if err != nil {
		return nil, err
	}
	services := p.services()
	p.startMu.Lock()
	defer p.startMu.Unlock()
	state.StartUpdate = append([]sok.StartFailure(nil), p.startFailures...)
	for _, plugin := range slices.Sorted(maps.Keys(p.held)) {
		entry := p.held[plugin]
		var sidecars []sok.HeldService
		holds := false
		if services != nil {
			sidecars, holds = services.HeldServices(entry.held)
		}
		if !holds {
			delete(p.held, plugin)
			continue
		}
		state.Held = append(state.Held, sok.HeldOperation{Plugin: plugin, Action: entry.action, Version: entry.held.Version,
			Error: entry.held.Error, Sidecars: sidecars})
	}
	return state, nil
}

// operate runs the installer for action on plugin with what it needs of the running services: the services are held from the
// comparison to the end of the apply step, a held operation is kept for pluginsState, and with end the services that hold it end
// before installed.json is written (docs/spec/persistent-services.md#updates). update runs the update at start, which stop ends.
// The caller holds p.running.
func (p *Plugins) operate(action, plugin string, end bool, stop func() bool) operation {
	var outcome operation
	running := sok.Running{}
	services := p.services()
	if services != nil && (action == "install" || action == "update" || action == "enable") {
		services.BeginPluginOperation()
		defer services.EndPluginOperation()
		live, err := services.RunningServices()
		if err != nil {
			return operation{err: err}
		}
		running.Services = live
		running.Held = func(held sok.Held) {
			outcome.held = true
			p.startMu.Lock()
			defer p.startMu.Unlock()
			p.held[plugin] = heldEntry{action: action, held: held}
		}
		if end {
			running.End = func(held sok.Held) error { return services.EndServices(context.Background(), held) }
		}
	}
	if stop != nil {
		outcome.result, outcome.err = sok.UpdatePluginUnless(p.configDir, plugin, p.core, p.platform, running, stop)
	} else {
		outcome.result, outcome.err = sok.RunPluginAction(p.configDir, action, plugin, p.core, p.platform, running)
	}
	if outcome.err != nil {
		return outcome
	}
	p.startMu.Lock()
	delete(p.held, plugin)
	p.startMu.Unlock()
	// The apply step changes the sidecars of the installation, so it does not run after the shutdown began.
	if stop != nil && stop() {
		return operation{err: errStopping}
	}
	outcome.applied = p.apply()
	return outcome
}

// operation is the outcome of operate: the result of the installer or its error, whether a running service held the operation, and
// the error of the apply step, which runs after a change of installed.json.
type operation struct {
	result  any
	err     error
	held    bool
	applied error
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
	end := false
	if request.End != nil {
		if request.End != true {
			return nil, errors.New("end must be true")
		}
		if request.Action != "install" && request.Action != "update" && request.Action != "enable" {
			return nil, fmt.Errorf("end does not apply to %s", request.Action)
		}
		end = true
	}
	if !p.running.TryLock() {
		return nil, errPluginOperationRunning
	}
	outcome := p.operate(request.Action, plugin, end, nil)
	p.running.Unlock()
	if outcome.err != nil {
		return nil, outcome.err
	}
	result, applied := outcome.result, outcome.applied
	// installed.json changed, so the windows are notified also when the apply step fails; that failure is the error of
	// the operation.
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
	// The enable of a plugin clears the sidecar stops of its manifest in one step, as a surface open does.
	if change.Action == "enable" {
		h.sidecars.PluginEnabled(change.Plugin)
	}
	for _, s := range windows {
		s.Emit("plugins-changed", change)
	}
}

// StartUpdate is the outcome of one step of the update at start (docs/spec/installation.md#update-at-start). Plugin is the id of
// the plugin that the step concerns; it is empty for a step about the registry. Err is the failure of the step, nil when the plugin
// was updated from From to To. A value with an empty Plugin and no Err reports that no registry is configured.
// Held reports that a running service holds the update, which stays as it is (docs/spec/persistent-services.md#updates).
type StartUpdate struct {
	Plugin, From, To string
	Err              error
	Held             bool
}

// Stop begins the shutdown of the host: the update at start starts no further plugin and changes no installation step after this
// call (docs/spec/installation.md#update-at-start).
func (p *Plugins) Stop() {
	p.stopped.Store(true)
}

// UpdateAtStart updates the installed plugins that the running core refuses or that are older than the newest accepted version
// (docs/spec/installation.md#update-at-start). Each update runs the same installer call, apply step and notification as
// core.plugins.update, and it waits for another plugin operation to end.
func (p *Plugins) UpdateAtStart() []StartUpdate {
	index, configured, err := sok.ReadRegistry(p.configDir)
	if err != nil {
		return []StartUpdate{{Err: err}}
	}
	if !configured {
		return []StartUpdate{{}}
	}
	state, manifests, err := sok.ReadInstalledManifests(p.configDir)
	if err != nil {
		return []StartUpdate{{Err: err}}
	}
	outdated, err := sok.OutdatedPlugins(index, state, manifests, p.core)
	if err != nil {
		return []StartUpdate{{Err: err}}
	}
	var results []StartUpdate
	for _, item := range outdated {
		if item.Candidate == "" {
			results = append(results, StartUpdate{Plugin: item.ID, From: item.Installed, Err: errors.New(item.Refused)})
			continue
		}
		if p.stopped.Load() {
			results = append(results, StartUpdate{Plugin: item.ID, From: item.Installed, Err: errStopping})
			continue
		}
		results = append(results, p.updateAtStart(item))
	}
	p.keepStartFailures(results)
	return results
}

// errStopping is the failure of an update at start that the shutdown of the host ended before it began.
var errStopping = errors.New("the host is shutting down")

// keepStartFailures keeps the failures among the results of the update at start for pluginsState. A failure of the registry has the place plugins update, and a
// failure of a plugin has the place plugin update <id>, the places of the error records of startUpdates.
func (p *Plugins) keepStartFailures(results []StartUpdate) {
	var failures []sok.StartFailure
	for _, result := range results {
		if result.Err == nil || result.Held {
			continue
		}
		where := "plugins update"
		if result.Plugin != "" {
			where = "plugin update " + result.Plugin
		}
		failures = append(failures, sok.StartFailure{Where: where, Text: result.Err.Error()})
	}
	p.startMu.Lock()
	defer p.startMu.Unlock()
	p.startFailures = failures
}

// updateAtStart runs the update of one outdated plugin as core.plugins.update does: the installer, the apply step, then the notification.
func (p *Plugins) updateAtStart(item sok.Outdated) StartUpdate {
	result := StartUpdate{Plugin: item.ID, From: item.Installed}
	p.running.Lock()
	outcome := p.operate("update", item.ID, false, p.stopped.Load)
	p.running.Unlock()
	if outcome.err != nil {
		result.Err, result.Held = outcome.err, outcome.held
		return result
	}
	applied := outcome.applied
	p.changed(PluginsChanged{Action: "update", Plugin: item.ID})
	if applied != nil {
		result.Err = fmt.Errorf("apply update %s: %w", item.ID, applied)
		return result
	}
	state, err := sok.ReadInstalled(p.configDir)
	if err != nil {
		result.Err = err
		return result
	}
	result.To = state.Plugins[item.ID].Version
	return result
}

// startUpdates runs UpdateAtStart on its own goroutine and stores each outcome in the event log, so the start does not wait for the
// registry. A failure is an error record; an update is the event host.plugins.update.
func (h *Host) startUpdates() {
	routine.Go("plugin-updates", func() {
		for _, update := range h.plugins.UpdateAtStart() {
			switch {
			case update.Plugin == "" && update.Err == nil:
				LogInfo("plugins", "no registry is configured")
			case update.Plugin == "":
				LogError("plugins update", update.Err)
			case update.Held:
				// The update waits for the person, who ends the services that hold it from the card of the plugin.
				LogInfo("plugin update "+update.Plugin, update.Err)
			case update.Err != nil:
				LogError("plugin update "+update.Plugin, update.Err)
			default:
				EmitHost(LevelInfo, "host.plugins.update", map[string]any{"plugin": update.Plugin, "from": update.From, "to": update.To})
			}
		}
	})
}
