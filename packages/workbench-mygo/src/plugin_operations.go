package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// The plugin operations of a window and the value of `core.plugins`, as packages/workbench/plugin-operations.js has them
// (docs/spec/installation.md#plugin-screen). The host keeps the state; a window reads it and runs its operations.

// PluginActions are the operations of the host call pluginsRun.
var PluginActions = []string{"install", "update", "remove", "enable", "disable"}

// PluginIndex is `index` of the plugin state: the checked registry index, or the error of its read.
type PluginIndex struct {
	sok.Index
	Error *string `json:"error"`
}

// PluginsState is the answer of the host call pluginsState. Index is nil when no registry is set.
type PluginsState struct {
	Core      string             `json:"core"`
	Registry  *string            `json:"registry"`
	Index     *PluginIndex       `json:"index"`
	Installed sok.InstalledState `json:"installed"`
	FirstRun  bool               `json:"firstRun"`
	Starter   *sok.StarterJob    `json:"starter"`
}

// PluginsStatus is the value of `core.plugins`.
type PluginsStatus struct {
	Core      *string           `json:"core"`
	Registry  *string           `json:"registry"`
	Error     *string           `json:"error"`
	Plugins   []PluginRow       `json:"plugins"`
	Operation *PluginOperation  `json:"operation"`
	Reload    bool              `json:"reload"`
	Updates   []PluginUpdate    `json:"updates"`
	Outdated  []OutdatedSidecar `json:"outdated"`
}

// listedVersions returns the plugins of the index by id, each with the versions that are not revoked
// (docs/spec/installation.md#version-selection).
func listedVersions(index *PluginIndex) map[string]sok.RegistryPlugin {
	listed := map[string]sok.RegistryPlugin{}
	if index == nil {
		return listed
	}
	for _, entry := range index.Plugins {
		entry.Versions = slices.DeleteFunc(slices.Clone(entry.Versions), func(item sok.PluginVersion) bool {
			return slices.ContainsFunc(index.Revoked.Plugins, func(revoked sok.RevokedPlugin) bool {
				return revoked.ID == entry.ID && revoked.Version == item.Version
			})
		})
		listed[entry.ID] = entry
	}
	return listed
}

// selectedVersion returns the version that installation selects: the newest whose range contains the core.
func selectedVersion(entry sok.RegistryPlugin, core string) (*sok.PluginVersion, error) {
	var selected *sok.PluginVersion
	for i := range entry.Versions {
		item := &entry.Versions[i]
		if !sok.Satisfies(core, item.Engines.Soksak) {
			continue
		}
		if selected == nil {
			selected = item
			continue
		}
		order, err := CompareVersions(item.Version, selected.Version)
		if err != nil {
			return nil, err
		}
		if order > 0 {
			selected = item
		}
	}
	return selected, nil
}

func sidecarRows(ranges map[string]string, state *PluginsState) []PluginSidecar {
	rows := []PluginSidecar{}
	for name, value := range ranges {
		row := PluginSidecar{Name: name, Range: &value}
		if state != nil {
			if installed, ok := state.Installed.Sidecars[name]; ok {
				version := installed.Version
				row.Version = &version
			}
		}
		rows = append(rows, row)
	}
	slices.SortFunc(rows, func(a, b PluginSidecar) int { return strings.Compare(a.Name, b.Name) })
	return rows
}

func rowState(unit *LoadedPlugin, record *sok.InstalledPlugin, refused bool) string {
	switch {
	case unit != nil && record != nil && record.Enabled && record.Version == unit.Version:
		return "loaded"
	case unit == nil && record != nil && !record.Enabled:
		return "disabled"
	case unit == nil && record == nil:
		return "available"
	case unit == nil && record.Enabled && refused: // A refused plugin is not loaded by a reload either.
		return "refused"
	}
	return "reload"
}

// PluginRows returns the rows of `core.plugins` in id order. state is nil before it was read, and refused holds the installed
// plugins that the window refused.
func PluginRows(loaded []LoadedPlugin, state *PluginsState, refused map[string]bool) ([]PluginRow, error) {
	units := map[string]*LoadedPlugin{}
	for i := range loaded {
		units[loaded[i].ID] = &loaded[i]
	}
	ids := []string{}
	for id := range units {
		ids = append(ids, id)
	}
	if state == nil {
		slices.Sort(ids)
		rows := make([]PluginRow, 0, len(ids))
		for _, id := range ids {
			unit := units[id]
			rows = append(rows, PluginRow{ID: id, Name: unit.Name, Description: unit.Description, State: "loaded", Composition: unit.Composition,
				Sidecars: sidecarRows(unit.Dependencies, nil)})
		}
		return rows, nil
	}
	listed := listedVersions(state.Index)
	for id := range state.Installed.Plugins {
		ids = append(ids, id)
	}
	for id, entry := range listed {
		if len(entry.Versions) > 0 { // A plugin without a usable version is not offered.
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
	rows := make([]PluginRow, 0, len(ids))
	for _, id := range ids {
		row, err := pluginRow(id, units[id], state, listed, refused[id])
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func pluginRow(id string, unit *LoadedPlugin, state *PluginsState, listed map[string]sok.RegistryPlugin, refused bool) (PluginRow, error) {
	var record *sok.InstalledPlugin
	if found, ok := state.Installed.Plugins[id]; ok {
		record = &found
	}
	entry, indexed := listed[id]
	selected, err := selectedVersion(entry, state.Core)
	if err != nil {
		return PluginRow{}, err
	}
	row := PluginRow{ID: id, Name: id, State: rowState(unit, record, refused), Incompatible: len(entry.Versions) > 0 && selected == nil}
	if indexed {
		row.Name, row.Description = entry.Name, entry.Description
	}
	if unit != nil {
		row.Name, row.Description, row.Composition = unit.Name, unit.Description, unit.Composition
	}
	if selected != nil {
		row.Latest = &selected.Version
	}
	if record != nil {
		row.Installed = &PluginInstalled{Version: record.Version, Enabled: record.Enabled}
	}
	switch {
	case record != nil:
		row.Sidecars = sidecarRows(record.Sidecars, state)
	case selected != nil:
		row.Sidecars = sidecarRows(selected.Sidecars, state)
	case unit != nil:
		row.Sidecars = sidecarRows(unit.Dependencies, state)
	}
	return row, nil
}

// PluginOperations is the one plugin operation state of a window. Its methods and the answers of its calls run on the main
// thread, and changed runs each time the state changes.
type PluginOperations struct {
	calls   *Calls
	loaded  func() []LoadedPlugin
	changed func()

	state     *PluginsState
	failure   *PluginFailure
	operation *PluginOperation
	outdated  []OutdatedSidecar
}

// NewPluginOperations returns the operations of a window over its host calls.
func NewPluginOperations(calls *Calls, loaded func() []LoadedPlugin, changed func()) *PluginOperations {
	return &PluginOperations{calls: calls, loaded: loaded, changed: changed, outdated: []OutdatedSidecar{}}
}

// Failure returns why the state or the index could not be read, and nil when it could.
func (p *PluginOperations) Failure() *PluginFailure { return p.failure }

// Refresh reads the state of the host again and then runs done. A read that fails is the failure of the state.
func (p *PluginOperations) Refresh(done func()) {
	p.calls.Call("pluginsState", nil, func(value any, err error) {
		p.state, p.failure = nil, nil
		if err == nil {
			var state PluginsState
			if state, err = decode[PluginsState](value); err == nil {
				p.state = &state
				if state.Index != nil && state.Index.Error != nil {
					p.failure = &PluginFailure{Kind: "index", Message: *state.Index.Error}
				}
			}
		}
		if err != nil {
			p.failure = &PluginFailure{Kind: "state", Message: err.Error()}
		}
		p.changed()
		done()
	})
}

// RefreshOutdated reads the outdated persistent services of the host again and then runs done.
func (p *PluginOperations) RefreshOutdated(done func()) {
	p.calls.Call("sidecarsOutdated", nil, func(value any, err error) {
		p.outdated = []OutdatedSidecar{}
		if err == nil {
			var outdated []OutdatedSidecar
			if outdated, err = decode[[]OutdatedSidecar](value); err == nil && outdated != nil {
				p.outdated = outdated
			}
		}
		if err != nil {
			p.failure = &PluginFailure{Kind: "state", Message: err.Error()}
		}
		p.changed()
		done()
	})
}

// Run runs one operation and reads the state again, and then answers with its failure.
func (p *PluginOperations) Run(action, plugin string, answer func(err error)) {
	p.operation = &PluginOperation{Action: action, Plugin: plugin, State: "running"}
	p.changed()
	p.calls.Call("pluginsRun", map[string]string{"action": action, "plugin": plugin}, func(_ any, err error) {
		p.operation = &PluginOperation{Action: action, Plugin: plugin, State: "done"}
		if err != nil {
			p.operation.State, p.operation.Error = "failed", err.Error()
		}
		p.Refresh(func() { answer(err) })
	})
}

// UpdateAll updates the plugins of `updates` one after the other and stops at the first failure.
func (p *PluginOperations) UpdateAll(answer func(err error)) {
	var next func(rest []PluginUpdate)
	next = func(rest []PluginUpdate) {
		if len(rest) == 0 {
			answer(nil)
			return
		}
		p.Run("update", rest[0].ID, func(err error) {
			if err != nil {
				answer(err)
				return
			}
			next(rest[1:])
		})
	}
	next(p.Status().Updates)
}

// UseRegistry sets the registry index and reads the state again.
func (p *PluginOperations) UseRegistry(index string, answer func(err error)) {
	p.calls.Call("pluginsUseRegistry", map[string]string{"index": index}, func(_ any, err error) {
		if err != nil {
			answer(err)
			return
		}
		p.Refresh(func() { answer(nil) })
	})
}

// Replace replaces the outdated service of sidecar and reads the outdated sidecars again, also after a failure.
func (p *PluginOperations) Replace(sidecar string, answer func(err error)) {
	p.calls.Call("sidecarsReplace", map[string]string{"sidecar": sidecar}, func(_ any, err error) {
		p.RefreshOutdated(func() { answer(err) })
	})
}

// Status returns the value of `core.plugins`.
func (p *PluginOperations) Status() PluginsStatus {
	status := PluginsStatus{Plugins: []PluginRow{}, Operation: p.operation, Updates: []PluginUpdate{}, Outdated: p.outdated}
	if p.failure != nil {
		status.Error = &p.failure.Message
	}
	if p.state == nil {
		return status
	}
	status.Core, status.Registry = &p.state.Core, p.state.Registry
	rows, err := PluginRows(p.loaded(), p.state, nil)
	if err != nil {
		message := err.Error()
		status.Error = &message
		return status
	}
	status.Plugins = rows
	for _, row := range rows {
		status.Reload = status.Reload || row.State == "reload"
		if update, err := hasUpdate(row); err == nil && update {
			status.Updates = append(status.Updates, PluginUpdate{ID: row.ID, Installed: row.Installed.Version, Latest: *row.Latest})
		}
	}
	return status
}

// starterRun is one run of the starter job of the first start. show shows a failure, and done receives whether the run
// installed a plugin, which the window then loads.
type starterRun struct {
	plugins   *PluginOperations
	pack      string
	registry  *string
	job       *sok.StarterJob
	show      func(text string)
	done      func(installed bool)
	installed bool
}

// InstallStarter starts the durable starter job on the first run, or resumes its plugin list after an interrupted install. A
// complete job is not enforced again, so later removals stay.
func (p *PluginOperations) InstallStarter(pack, registry *string, show func(text string), done func(installed bool)) {
	var job *sok.StarterJob
	if p.state != nil {
		job = p.state.Starter
	}
	if job != nil && job.State == "complete" {
		done(false)
		return
	}
	if job == nil && (pack == nil || p.state == nil || !p.state.FirstRun) {
		done(false)
		return
	}
	run := &starterRun{plugins: p, registry: registry, job: job, show: show, done: done}
	if pack != nil {
		run.pack = *pack
	}
	if job == nil && p.state.Registry == nil && registry != nil {
		p.UseRegistry(*registry, func(err error) {
			if run.failed(err) {
				return
			}
			run.prepare()
		})
		return
	}
	run.prepare()
}

// failed ends the run when err or the failure of the state stopped it.
func (r *starterRun) failed(err error) bool {
	if err == nil && r.plugins.state == nil {
		err = errors.New(r.plugins.failure.Message)
	}
	if err == nil {
		return false
	}
	name := r.pack
	if r.job != nil {
		name = r.job.Pack
	}
	r.show(fmt.Sprintf("시작 플러그인 묶음 %s을 설치하지 못했습니다 · %s.", name, err))
	r.done(false)
	return true
}

func (r *starterRun) prepare() {
	state := r.plugins.state
	if r.job == nil && state.Registry == nil {
		r.show(fmt.Sprintf("플러그인 레지스트리가 없어 시작 플러그인 묶음 %s을 설치하지 못했습니다. sok registry use 로 레지스트리를 정한 뒤 다시 시작하세요.", r.pack))
		r.done(false)
		return
	}
	if state.Index != nil && state.Index.Error != nil {
		r.failed(errors.New(*state.Index.Error))
		return
	}
	if r.job != nil {
		switch {
		case r.job.State != "pending":
			r.failed(fmt.Errorf("starter job has unknown state %s", r.job.State))
		case state.Registry == nil || *state.Registry != r.job.Registry:
			r.failed(fmt.Errorf("starter job registry %s differs from the current registry", r.job.Registry))
		default:
			r.install(r.job.Plugins)
		}
		return
	}
	var plugins []string
	if state.Index != nil {
		index := slices.IndexFunc(state.Index.Packs, func(item sok.RegistryPack) bool { return item.Name == r.pack })
		if index < 0 {
			r.failed(fmt.Errorf("the registry has no pack %s", r.pack))
			return
		}
		plugins = state.Index.Packs[index].Plugins
	} else {
		r.failed(fmt.Errorf("the registry has no pack %s", r.pack))
		return
	}
	r.record("pending", *state.Registry, plugins, func() {
		r.job = r.plugins.state.Starter
		if r.job == nil || r.job.State != "pending" {
			r.failed(errors.New("starter job was not recorded as pending"))
			return
		}
		r.install(r.job.Plugins)
	})
}

// record writes the job and reads the state again.
func (r *starterRun) record(state, registry string, plugins []string, next func()) {
	request := sok.StarterJobRequest{State: state, Pack: r.pack, Registry: registry, Plugins: plugins}
	if r.job != nil {
		request.Pack = r.job.Pack
	}
	r.plugins.calls.Call("pluginsStarter", request, func(_ any, err error) {
		if r.failed(err) {
			return
		}
		r.plugins.Refresh(func() {
			if !r.failed(nil) {
				next()
			}
		})
	})
}

func (r *starterRun) install(rest []string) {
	if len(rest) == 0 {
		r.record("complete", r.job.Registry, r.job.Plugins, func() {
			if r.plugins.state.Starter == nil || r.plugins.state.Starter.State != "complete" {
				r.failed(errors.New("starter job was not recorded as complete"))
				return
			}
			r.done(r.installed)
		})
		return
	}
	id := rest[0]
	if _, ok := r.plugins.state.Installed.Plugins[id]; ok {
		r.install(rest[1:])
		return
	}
	r.plugins.Run("install", id, func(err error) {
		if r.failed(err) {
			return
		}
		r.installed = true
		if _, ok := r.plugins.state.Installed.Plugins[id]; !ok {
			r.failed(fmt.Errorf("starter plugin %s was not recorded as installed", id))
			return
		}
		r.install(rest[1:])
	})
}

// MarshalJSON writes the operation as `operation` of `core.plugins`, whose error is null without a failure.
func (o PluginOperation) MarshalJSON() ([]byte, error) {
	var failure *string
	if o.Error != "" {
		failure = &o.Error
	}
	return json.Marshal(struct {
		Action string  `json:"action"`
		Plugin string  `json:"plugin"`
		State  string  `json:"state"`
		Error  *string `json:"error"`
	}{o.Action, o.Plugin, o.State, failure})
}
