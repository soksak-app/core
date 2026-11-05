package workbench

import (
	"fmt"
	"slices"
	"strings"
	"time"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// The tab ports of a window of the application (docs/spec/plugins.md): the installed plugins, the settings store, the event writer of
// the window, its surfaces and its timers.

// shellPlugins returns the installed plugins as the tab parts read them, in the order of their ids.
func (s *Shell) shellPlugins() []ShellPlugin {
	plugins := make([]ShellPlugin, 0, len(s.units))
	for _, unit := range s.units {
		plugins = append(plugins, ShellPlugin{ID: unit.ID, Opens: unit.Opens, Unload: unit.Unload != nil, Background: unit.Background})
	}
	slices.SortFunc(plugins, func(a, b ShellPlugin) int { return strings.Compare(a.ID, b.ID) })
	return plugins
}

// pluginSettings returns the current values of the settings of plugin.
func (s *Shell) pluginSettings(plugin string) map[string]any {
	unit := s.units[plugin]
	if unit == nil {
		return nil
	}
	values := make(map[string]any, len(unit.Settings))
	for _, local := range unit.Settings {
		values[local] = s.settings.Value(plugin + "." + local)
	}
	return values
}

// memoryDelay returns the setting memorySaverDelay in minutes. The store holds a number between the bounds of the declaration.
func (s *Shell) memoryDelay() int {
	delay, _ := s.settings.Value("memorySaverDelay").(float64) // silent: the settings store checks the type of the value.
	return int(delay)
}

// memoryEnabled returns the setting memorySaver.
func (s *Shell) memoryEnabled() bool {
	enabled, _ := s.settings.Value("memorySaver").(bool) // silent: the settings store checks the type of the value.
	return enabled
}

// emitTabEvent writes an event of the tab parts to the event writer of the window.
func (s *Shell) emitTabEvent(level, name string, fields map[string]any) {
	// events: forwarded
	s.events.Emit(sok.Level(level), name, func() map[string]any { return fields }, nil)
}

// seedSession reads the stored session of tab for the regions that its surface attaches. A failed read is reported, and the regions
// attach without it.
func (s *Shell) seedSession(tab string) *storedSession {
	session := &storedSession{}
	s.surfaces.sessions[tab] = session
	settled := func() {
		session.read = true
		for _, run := range session.waiting {
			run()
		}
		session.waiting = nil
	}
	if s.tabs == nil {
		settled()
		return session
	}
	s.tabs.sessions.Read(tab, func(states map[string]string, err error) {
		if err != nil {
			s.options.Report(fmt.Sprintf("memory saver: tab %s: session read failed: %s", tab, err))
		}
		session.states, session.history = states, len(states) > 0
		settled()
	})
	return session
}

// storedSessionOf gives ready the stored session of tab after its read ended.
func (s *Shell) storedSessionOf(tab string, ready func(session *storedSession)) {
	session := s.surfaces.sessions[tab]
	if session == nil {
		session = s.seedSession(tab)
	}
	if session.read {
		ready(session)
		return
	}
	session.waiting = append(session.waiting, func() { ready(session) })
}

// attachDocument attaches a document region with the interactionState that it restores once. A refused interactionState is reported,
// and the region attaches again without it, because a lost session history is a smaller loss than a tab without its document
// (docs/spec/plugins.md#memory-saver).
func (s *Shell) attachDocument(call viewCallEvent, name string, answer viewAnswer) {
	attached := func(history bool) {
		if s.surfaces.documents[call.Surface] == nil {
			s.surfaces.documents[call.Surface] = map[string]bool{}
		}
		s.surfaces.documents[call.Surface][name] = true
		answer(map[string]any{"history": history}, nil)
	}
	s.storedSessionOf(call.Surface, func(session *storedSession) {
		state, restores := session.states[name]
		if !restores {
			s.surfaceCall(call, "documentAttach", map[string]any{"document": name}, func(_ any, err error) {
				if err != nil {
					answer(nil, err)
					return
				}
				attached(false)
			})
			return
		}
		delete(session.states, name)
		s.surfaceCall(call, "documentAttach", map[string]any{"document": name, "interactionState": state}, func(_ any, err error) {
			if err == nil {
				attached(true)
				return
			}
			s.tabs.saver.HistoryRefused(call.Surface, call.Plugin, fmt.Sprintf("document region %s: %s", name, err))
			session.history = false
			s.surfaceCall(call, "documentAttach", map[string]any{"document": name}, func(_ any, err error) {
				if err != nil {
					answer(nil, err)
					return
				}
				attached(false)
			})
		})
	})
}

// documentState gives the tab session a changed history of a document region, a navigation commit after which the session is written.
func (s *Shell) documentState(data []any) {
	if s.tabs == nil || len(data) != 1 {
		return
	}
	event, err := decode[struct {
		Surface  string `json:"surface"`
		Document string `json:"document"`
		State    struct {
			History *TabHistory `json:"history"`
		} `json:"state"`
	}](data[0])
	if err != nil {
		s.fail(fmt.Errorf("document state: %w", err))
		return
	}
	if event.State.History != nil {
		s.tabs.sessions.Navigated(event.Surface, event.Document, *event.State.History)
	}
}

// documentNames returns the names of the document regions of tab in order.
func (s *Shell) documentNames(tab string) []string {
	names := make([]string, 0, len(s.surfaces.documents[tab]))
	for name := range s.surfaces.documents[tab] {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// shellSurfaces is what the tab parts read of the surfaces of a window.
type shellSurfaces struct{ shell *Shell }

func (f shellSurfaces) Mounted(tab string) bool { return f.shell.surfaces.held[tab] != nil }

func (f shellSurfaces) DetachHeld(tab string) bool { return f.shell.surfaces.detachHeld(tab) }

func (f shellSurfaces) Keeps(tab string) []string {
	report := f.shell.surfaces.reports[tab]
	if report == nil {
		return nil
	}
	keeps := make([]string, 0, len(report.Keeps))
	for reason := range report.Keeps {
		keeps = append(keeps, "keep:"+reason)
	}
	slices.Sort(keeps)
	return keeps
}

// Regions queries each document region of tab in turn. A query that fails gives media-unknown and is written to the log.
func (f shellSurfaces) Regions(tab string, answer func(reasons []string, err error)) {
	s := f.shell
	found := map[string]bool{}
	names := s.documentNames(tab)
	var next func(index int)
	next = func(index int) {
		if index == len(names) {
			var reasons []string
			for _, reason := range []string{"media", "media-unknown", "capture", "form"} {
				if found[reason] {
					reasons = append(reasons, reason)
				}
			}
			answer(reasons, nil)
			return
		}
		s.calls.Call("documentQuery", map[string]string{"surface": tab, "document": names[index]}, func(value any, err error) {
			reply, failure := decode[struct{ Media, Capture, Form bool }](value)
			if err == nil {
				err = failure
			}
			if err != nil {
				found["media-unknown"] = true
				s.options.Report(fmt.Sprintf("memory saver: tab %s: %s", tab, err))
			}
			found["media"] = found["media"] || reply.Media
			found["capture"] = found["capture"] || reply.Capture
			found["form"] = found["form"] || reply.Form
			next(index + 1)
		})
	}
	next(0)
}

// Interaction reads the interactionState of each document region of tab in turn. A region that detached during its read has no state
// to store.
func (f shellSurfaces) Interaction(tab string, answer func(history map[string]string, err error)) {
	s := f.shell
	history := map[string]string{}
	names := s.documentNames(tab)
	var next func(index int)
	next = func(index int) {
		if index == len(names) {
			if len(history) == 0 {
				history = nil
			}
			answer(history, nil)
			return
		}
		name := names[index]
		s.calls.Call("documentInteractionState", map[string]string{"surface": tab, "document": name}, func(value any, err error) {
			if err != nil {
				if !s.surfaces.documents[tab][name] {
					next(index + 1)
					return
				}
				answer(nil, err)
				return
			}
			state, err := decode[*string](value)
			if err != nil {
				answer(nil, err)
				return
			}
			if state != nil && *state != "" {
				history[name] = *state
			}
			next(index + 1)
		})
	}
	next(0)
}

func (f shellSurfaces) AttachedTabs() []string {
	tabs := make([]string, 0, len(f.shell.surfaces.documents))
	for tab, names := range f.shell.surfaces.documents {
		if len(names) > 0 {
			tabs = append(tabs, tab)
		}
	}
	slices.Sort(tabs)
	return tabs
}

func (f shellSurfaces) Restore(tab string) { f.shell.seedSession(tab) }

func (f shellSurfaces) ReportTitle(tab, label string) {
	if report := f.shell.report(tab); report.Title != label {
		report.Title = label
		f.shell.options.Invalidate()
	}
}

func (f shellSurfaces) ReportState(string, string) { f.shell.options.Invalidate() }

// tabPorts returns the tab ports of the window of shell.
func (a *App) tabPorts(shell *Shell) TabPorts {
	began := time.Now()
	now, after := func() int64 { return time.Since(began).Milliseconds() }, a.After
	if clock := a.options.Clock; clock != nil {
		now, after = clock.Now, clock.After
	}
	return TabPorts{
		Plugins:        shell.shellPlugins,
		Surfaces:       shellSurfaces{shell},
		Enabled:        shell.memoryEnabled,
		Delay:          shell.memoryDelay,
		PluginSettings: shell.pluginSettings,
		Commit:         shell.commitSurfaces,
		Emit:           shell.emitTabEvent,
		Now:            now,
		After:          after,
	}
}
