package workbench

import (
	"cmp"
	"encoding/json"
	"errors"
	"regexp"
	"slices"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// The application update state and operation of a window (docs/spec/installation.md#application-update).

// publishedRelease is the URL of a file of a published release, `<repository>/releases/download/<tag>/<file>`.
var publishedRelease = regexp.MustCompile(`^(https://[^/]+/[^/]+/[^/]+)/releases/download/([^/]+)/[^/]+$`)

// releasePage returns the page of a published release for the URL of its file, and an empty text for any other URL, which names no page.
func releasePage(url string) string {
	match := publishedRelease.FindStringSubmatch(url)
	if match == nil {
		return ""
	}
	return match[1] + "/releases/tag/" + match[2]
}

// AppUpdates is the application update of a window.
type AppUpdates struct {
	calls   *Calls
	plugins func() *PluginsState
	changed func()

	state     *sok.AppUpdateState
	failure   string
	operation *AppOperation
}

// NewAppUpdates returns the application update of a window over its host calls. plugins returns the plugin state of the host, or nil
// before it was read, and changed runs whenever the state or the operation changes.
func NewAppUpdates(calls *Calls, plugins func() *PluginsState, changed func()) *AppUpdates {
	return &AppUpdates{calls: calls, plugins: plugins, changed: changed}
}

// Refresh reads the candidate of the registry index again. A read that fails is the error of the status.
func (u *AppUpdates) Refresh() {
	u.calls.Call("appUpdateState", nil, func(value any, err error) {
		u.state, u.failure = nil, ""
		if err == nil {
			var state sok.AppUpdateState
			if state, err = decode[sok.AppUpdateState](value); err == nil {
				u.state = &state
			}
		}
		if err != nil {
			u.failure = err.Error()
		}
		u.changed()
	})
}

// Update stages the candidate and then applies the staged bundle, which quits the application.
func (u *AppUpdates) Update(answer func(err error)) {
	if u.state == nil || u.state.Available == nil {
		answer(errors.New("no application update is available"))
		return
	}
	version := u.state.Available.Version
	failed := func(err error) {
		u.operation = &AppOperation{Version: version, State: "failed", Error: err.Error()}
		u.changed()
		answer(err)
	}
	u.operation = &AppOperation{Version: version, State: "staging"}
	u.changed()
	u.calls.Call("appUpdateStage", map[string]string{"version": version}, func(value any, err error) {
		if err != nil {
			failed(err)
			return
		}
		staged, err := decode[struct {
			Bundle string `json:"bundle"`
		}](value)
		if err != nil {
			failed(err)
			return
		}
		u.operation = &AppOperation{Version: version, State: "applying"}
		u.changed()
		u.calls.Call("appUpdateApply", map[string]string{"bundle": staged.Bundle}, func(_ any, err error) {
			if err != nil {
				failed(err)
				return
			}
			answer(nil)
		})
	})
}

// OpenRelease opens the release page of the candidate in the default application of the person.
func (u *AppUpdates) OpenRelease(answer func(err error)) {
	available := u.Status().Available
	if available == nil || available.Release == "" {
		answer(errors.New("the application update has no release page"))
		return
	}
	u.calls.Call("linkOpen", map[string]string{"url": available.Release}, func(_ any, err error) { answer(err) })
}

// Status returns the value of the status core.app.
func (u *AppUpdates) Status() AppUpdate {
	status := AppUpdate{Operation: u.operation, Error: u.failure, Incompatible: []AppIncompatible{}}
	if u.state == nil {
		return status
	}
	status.Version = u.state.Version
	if candidate := u.state.Available; candidate != nil {
		status.Available = &AppVersion{Version: candidate.Version, Release: releasePage(candidate.Release.URL)}
		incompatible, err := incompatiblePlugins(u.plugins(), candidate.Version)
		if err != nil {
			status.Error = err.Error()
			return status
		}
		status.Incompatible = incompatible
	}
	return status
}

// incompatiblePlugins returns the installed plugins whose range does not contain the candidate, by id, each with the newest version of
// the plugin that does and is not revoked. A plugin whose installed version the index does not list is not judged.
func incompatiblePlugins(state *PluginsState, candidate string) ([]AppIncompatible, error) {
	found := []AppIncompatible{}
	if state == nil || state.Index == nil {
		return found, nil
	}
	selectable := listedVersions(state.Index)
	for _, entry := range state.Index.Plugins {
		record, installed := state.Installed.Plugins[entry.ID]
		if !installed {
			continue
		}
		at := slices.IndexFunc(entry.Versions, func(item sok.PluginVersion) bool { return item.Version == record.Version })
		if at < 0 || sok.Satisfies(candidate, entry.Versions[at].Engines.Soksak) {
			continue
		}
		fits, err := selectedVersion(selectable[entry.ID], candidate)
		if err != nil {
			return nil, err
		}
		item := AppIncompatible{ID: entry.ID, Installed: record.Version, Range: entry.Versions[at].Engines.Soksak}
		if fits != nil {
			item.Compatible = &fits.Version
		}
		found = append(found, item)
	}
	slices.SortFunc(found, func(a, b AppIncompatible) int { return cmp.Compare(a.ID, b.ID) })
	return found, nil
}

// orNull returns a text as a JSON value, in which an empty text is null.
func orNull(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

// MarshalJSON writes the application update as the value of `core.app`.
func (a AppUpdate) MarshalJSON() ([]byte, error) {
	type version struct {
		Version string  `json:"version"`
		Release *string `json:"release"`
	}
	type operation struct {
		State   string  `json:"state"`
		Version string  `json:"version"`
		Error   *string `json:"error"`
	}
	type incompatible struct {
		ID         string  `json:"id"`
		Installed  string  `json:"installed"`
		Range      string  `json:"range"`
		Compatible *string `json:"compatible"`
	}
	value := struct {
		Version      *string        `json:"version"`
		Available    *version       `json:"available"`
		Operation    *operation     `json:"operation"`
		Error        *string        `json:"error"`
		Incompatible []incompatible `json:"incompatible"`
	}{Version: orNull(a.Version), Error: orNull(a.Error), Incompatible: []incompatible{}}
	if a.Available != nil {
		value.Available = &version{a.Available.Version, orNull(a.Available.Release)}
	}
	if a.Operation != nil {
		value.Operation = &operation{a.Operation.State, a.Operation.Version, orNull(a.Operation.Error)}
	}
	for _, item := range a.Incompatible {
		value.Incompatible = append(value.Incompatible, incompatible(item))
	}
	return json.Marshal(value)
}
