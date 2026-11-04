package workbench

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// The tab ports of a window of the application (docs/spec/plugins.md): the installed plugins, the values of their settings, the event
// writer of the window and its timers.

// tabPlugins returns the installed plugins as the tab parts read them, and the default of each plugin setting by <plugin>.<local>, with
// the initial value of the environment declaration in its place.
func tabPlugins(installed []InstalledPlugin, environment []byte) ([]ShellPlugin, map[string]any, error) {
	var declared struct {
		Settings map[string]map[string]any `json:"settings"`
	}
	if err := json.Unmarshal(environment, &declared); err != nil {
		return nil, nil, fmt.Errorf("environment declaration: %w", err)
	}
	plugins := make([]ShellPlugin, 0, len(installed))
	defaults := map[string]any{}
	for _, plugin := range installed {
		manifest := plugin.Manifest
		plugins = append(plugins, ShellPlugin{ID: plugin.ID, Opens: manifest.Surface.Opens.Extensions,
			Unload: len(manifest.Surface.Unload) > 0, Background: manifest.Background})
		for local, setting := range manifest.Settings {
			value := setting.Default
			if initial, held := declared.Settings[plugin.ID][local]; held {
				value = initial
			}
			defaults[plugin.ID+"."+local] = value
		}
	}
	return plugins, defaults, nil
}

// memorySettings holds the values of the memory saver settings, which the shell reads from the common settings of a workspace snapshot
// over the defaults of the workbench declaration.
type memorySettings struct {
	MemorySaver      bool `json:"memorySaver"`
	MemorySaverDelay int  `json:"memorySaverDelay"`
}

// readMemorySettings reads the values of the memory saver settings in the common settings.
func readMemorySettings(common map[string]any) (memorySettings, error) {
	var declared struct {
		Settings struct {
			Defaults         memorySettings `json:"defaults"`
			MemorySaverDelay [2]int         `json:"memorySaverDelay"`
		} `json:"settings"`
	}
	if err := json.Unmarshal(workbenchFile, &declared); err != nil {
		return memorySettings{}, fmt.Errorf("workbench.json: %w", err)
	}
	values := declared.Settings.Defaults
	text, err := json.Marshal(common)
	if err != nil {
		return values, err
	}
	if err := json.Unmarshal(text, &values); err != nil {
		return values, fmt.Errorf("common settings: %w", err)
	}
	if bounds := declared.Settings.MemorySaverDelay; values.MemorySaverDelay < bounds[0] || values.MemorySaverDelay > bounds[1] {
		return values, fmt.Errorf("common settings: memorySaverDelay %d is outside %d to %d", values.MemorySaverDelay, bounds[0], bounds[1])
	}
	return values, nil
}

// pluginSettings returns the current values of the settings of plugin: the override of the shown project, the common value, or the
// default.
func (s *Shell) pluginSettings(plugin string, defaults map[string]any) map[string]any {
	var overrides map[string]any
	if project := s.opened(); project != nil {
		if err := member(project.Rest, "settings", &overrides); err != nil {
			s.fail(err)
		}
	}
	values := map[string]any{}
	for key, value := range defaults {
		local, held := strings.CutPrefix(key, plugin+".")
		if !held {
			continue
		}
		if common, found := s.commonSettings[key]; found {
			value = common
		}
		if override, found := overrides[key]; found {
			value = override
		}
		values[local] = value
	}
	return values
}

// emitEvent writes the event to the log of the host, in the order of the calls. The host stores the times of an event in its own clocks,
// so each event reads them first.
func (s *Shell) emitEvent(level, name string, fields map[string]any) {
	failed := func(err error) { s.options.Report(fmt.Sprintf("log %s: %s", name, err)) }
	if fields == nil {
		fields = map[string]any{}
	}
	s.calls.CallInOrder("log", "log", map[string]string{"action": "clock"}, func(value any, err error) {
		if err != nil {
			failed(err)
			return
		}
		clock, err := decode[host.ClockReading](value)
		if err != nil {
			failed(err)
			return
		}
		s.calls.CallInOrder("log", "log", map[string]any{"action": "batch", "events": []map[string]any{{"ts_us": clock.TsMicros,
			"mono_ns": clock.MonoNs, "level": level, "event": name, "fields": fields, "start": s.page}}}, func(_ any, err error) {
			if err != nil {
				failed(err)
			}
		})
	})
}

// unmountedSurfaces is what the tab parts read of a window that mounts no surface of a tab: no tab has a mounted surface or a document
// region, so the session of a tab stays with its background session and an unload has nothing to capture.
type unmountedSurfaces struct{}

func (unmountedSurfaces) Mounted(string) bool    { return false }
func (unmountedSurfaces) DetachHeld(string) bool { return false }
func (unmountedSurfaces) Keeps(string) []string  { return nil }
func (unmountedSurfaces) Regions(_ string, answer func([]string, error)) {
	answer(nil, nil)
}
func (unmountedSurfaces) Interaction(_ string, answer func(map[string]string, error)) {
	answer(nil, nil)
}
func (unmountedSurfaces) AttachedTabs() []string     { return nil }
func (unmountedSurfaces) Restore(string)             {}
func (unmountedSurfaces) ReportTitle(string, string) {}
func (unmountedSurfaces) ReportState(string, string) {}

// tabPorts returns the tab ports of the window of shell.
func (a *App) tabPorts(shell *Shell) TabPorts {
	plugins, defaults, err := tabPlugins(shell.installed, a.options.Environment)
	if err != nil {
		shell.fail(err)
	}
	began := time.Now()
	return TabPorts{
		Plugins:        func() []ShellPlugin { return plugins },
		Surfaces:       unmountedSurfaces{},
		Enabled:        func() bool { return shell.memory.MemorySaver },
		Delay:          func() int { return shell.memory.MemorySaverDelay },
		PluginSettings: func(plugin string) map[string]any { return shell.pluginSettings(plugin, defaults) },
		Commit: func(answer func(err error)) {
			shell.options.Invalidate()
			a.options.Post(func() { answer(nil) })
		},
		Emit:  shell.emitEvent,
		Now:   func() int64 { return time.Since(began).Milliseconds() },
		After: a.After,
	}
}
