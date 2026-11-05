package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The file commands, the memory saver, the tab stores and the background sessions of a window (docs/spec/plugins.md). They read the
// plane of the shown project, and the rest of what they read comes through TabPorts.

// ShellPlugin is a loaded plugin as these parts read it.
type ShellPlugin struct {
	ID string
	// Opens holds the extensions of surface.opens.
	Opens []string
	// Unload tells whether the surface of the plugin declares surface.unload.
	Unload bool
	// Background is the background declaration, or nil.
	Background *BackgroundDeclaration
}

// TabSurfaces is what these parts read of the surfaces and the document regions of a window.
type TabSurfaces interface {
	// Mounted tells whether the surface of tab is mounted.
	Mounted(tab string) bool
	// DetachHeld tells whether an image detach of tab is pending or failed.
	DetachHeld(tab string) bool
	// Keeps returns the keep reasons of the tab reports (keep:modified, keep:busy).
	Keeps(tab string) []string
	// Regions answers with the reasons of the document regions of tab (media, media-unknown, capture, form).
	Regions(tab string, answer func(reasons []string, err error))
	// Interaction answers with the interactionState of each region of tab that yields one, or nil when none does.
	Interaction(tab string, answer func(history map[string]string, err error))
	// AttachedTabs lists the tabs that have attached regions.
	AttachedTabs() []string
	// Restore gives the regions of a restored tab the stored session history.
	Restore(tab string)
	// ReportTitle shows the cached label of a tab that starts unloaded.
	ReportTitle(tab, label string)
	// ReportState receives each change of the memory saver state of a tab.
	ReportState(tab, state string)
}

// TabPorts is what a shell needs for these parts. Every port and every answer runs in a step of the main thread.
type TabPorts struct {
	// Plugins returns the loaded plugins.
	Plugins  func() []ShellPlugin
	Surfaces TabSurfaces
	// Enabled and Delay read the settings memorySaver and memorySaverDelay (minutes).
	Enabled func() bool
	Delay   func() int
	// PluginSettings returns the current values of the settings of plugin.
	PluginSettings func(plugin string) map[string]any
	// Commit requests a commit and answers after host.place replied.
	Commit func(answer func(err error))
	// Emit writes the event name with its level and fields to the log.
	Emit func(level, name string, fields map[string]any)
	// Now returns the monotonic time in milliseconds.
	Now func() int64
	// After runs run once in a later step after milliseconds and returns what cancels it.
	After func(milliseconds int64, run func()) (cancel func())
}

// shellTabs holds these parts of one window.
type shellTabs struct {
	ports      TabPorts
	saver      *MemorySaver
	states     *TabStates
	sessions   *TabSessions
	background *BackgroundSessions
	sidecars   *HostSidecars
	after      func(milliseconds int64, run func()) (cancel func())
	started    bool
	// sectionsStarted tells that the first frame of a plane ended the start for the sections, and seats holds the seats that the
	// memory saver read last.
	sectionsStarted bool
	seats           []string
	// hiddenDue tells that a change of the plane may have left a hidden tab without its surface.
	hiddenDue bool
	closed    bool
	// shown tells that the host took the first shown project, and failed that it refused it.
	shown, failed bool
	waiting       func(err error)
}

func (s *Shell) pluginOf(id string) *ShellPlugin {
	for _, plugin := range s.tabs.ports.Plugins() {
		if plugin.ID == id {
			return &plugin
		}
	}
	return nil
}

// connectTabs makes these parts over ports and registers their commands.
func (s *Shell) connectTabs(ports TabPorts) {
	tabs := &shellTabs{ports: ports, sidecars: NewHostSidecars(s.calls, s.options.Report)}
	s.tabs = tabs
	failed := func(text string) { s.fail(errors.New(text)) }
	// A timer of these parts does not outlive the window, whose host calls end with it.
	tabs.after = func(milliseconds int64, run func()) (cancel func()) {
		return ports.After(milliseconds, func() {
			if !tabs.closed {
				run()
			}
		})
	}
	tabs.saver = NewMemorySaver(MemorySaverPorts{
		Now: ports.Now, Enabled: ports.Enabled, Delay: ports.Delay,
		Declaration: func(surface MemorySurface) string {
			plugin := s.pluginOf(surface.Plugin)
			return UnloadDeclaration(surface, plugin != nil && plugin.Background != nil)
		},
		Keeps:       ports.Surfaces.Keeps,
		Kept:        func(tab string) bool { return tabs.states.Kept(tab) },
		SetKept:     func(tab string, on bool) { tabs.states.SetKept(tab, on) },
		Regions:     ports.Surfaces.Regions,
		Interaction: func(tab string, answer func(error)) { tabs.sessions.Capture(tab, "unload", answer) },
		Restore:     ports.Surfaces.Restore,
		Commit:      ports.Commit,
		ShowLabel: func(tab string) {
			if label := tabs.states.Label(tab); label != nil {
				ports.Surfaces.ReportTitle(tab, *label)
			}
		},
		Changed: func() {
			if err := s.registry.Changed(); err != nil {
				s.options.Report(err.Error())
			}
			s.options.Invalidate()
		},
		Failed:       failed,
		StateChanged: ports.Surfaces.ReportState,
		Emit:         ports.Emit,
		After:        tabs.after,
	})
	tabs.sessions = NewTabSessions(TabSessionPorts{Store: HostTabStore{s.calls}, Interaction: ports.Surfaces.Interaction, Tabs: ports.Surfaces.AttachedTabs,
		Failed: failed, Emit: ports.Emit, After: tabs.after})
	tabs.background = NewBackgroundSessions(BackgroundPorts{
		Ready:  func() bool { return tabs.shown },
		Failed: func() bool { return tabs.failed },
		Wait:   func(answer func(error)) { tabs.waiting = answer },
		Tabs:   s.backgroundTabs,
		Declaration: func(id string) *BackgroundDeclaration {
			if plugin := s.pluginOf(id); plugin != nil {
				return plugin.Background
			}
			return nil
		},
		Held:     ports.Surfaces.DetachHeld,
		Mounted:  ports.Surfaces.Mounted,
		Sidecar:  tabs.sidecars.Port,
		Settings: ports.PluginSettings,
		Report:   s.options.Report,
		Emit:     ports.Emit,
	})
	RegisterFileCommands(s.registry, shellFiles{s}, s.calls)
	RegisterMemorySaver(s.registry, tabs.saver, ports.Enabled, ports.Delay)
}

// openTabs opens the tab state store and runs next. A store that does not open is shown, and the memory saver then observes nothing,
// because the mark kept and the label cache live in that store.
func (s *Shell) openTabs(next func()) {
	if s.tabs == nil {
		next()
		return
	}
	OpenTabStates(TabStatePorts{
		Store:  HostTabStore{s.calls},
		Failed: func(text string) { s.fail(errors.New(text)) },
		UnloadOf: func(id string) bool {
			plugin := s.pluginOf(id)
			return plugin != nil && plugin.Unload
		},
		Emit:  s.tabs.ports.Emit,
		After: s.tabs.after,
	}, func(states *TabStates, err error) {
		if err != nil {
			s.fail(err)
			next()
			return
		}
		s.tabs.states = states
		s.reconcileTabs(next)
	})
}

// reconcileTabs removes the stored entries of surfaces in no layout. A stored layout that cannot be read leaves the tab ids unknown, so
// the stores keep every entry and the error is shown.
func (s *Shell) reconcileTabs(next func()) {
	kept, err := s.storedSurfaceKept()
	if err != nil {
		s.fail(err)
		next()
		return
	}
	s.tabs.states.Reconcile(kept, func() {
		s.tabs.sessions.Reconcile(kept, func(err error) {
			if err != nil {
				s.fail(err)
			}
			next()
		})
	})
}

// shownProject ends the wait of the background sessions for the first shown project.
func (s *Shell) shownProject(err error) {
	if s.tabs == nil {
		return
	}
	if err != nil {
		s.tabs.failed = true
	} else {
		s.tabs.shown = true
	}
	if waiting := s.tabs.waiting; waiting != nil {
		s.tabs.waiting = nil
		waiting(err)
	}
}

// eachTab calls visit with each tab of state and whether it is the active tab of its card.
func eachTab(cards []layout.Card, visit func(tab layout.Tab, active bool)) {
	for _, card := range cards {
		data, err := layout.DecodeCardData(card.Data)
		if err != nil || data == nil {
			continue // A place card has no tabs, and the shell refuses a stored card that does not read when it loads the space.
		}
		active := data.ActiveTab()
		for _, tab := range data.TabList() {
			visit(tab, active != nil && active.ID == tab.ID)
		}
	}
}

// backgroundTabs returns the tabs of the plane.
func (s *Shell) backgroundTabs() []BackgroundTab {
	var tabs []BackgroundTab
	if s.plane != nil {
		eachTab(s.plane.Cards(), func(tab layout.Tab, active bool) {
			tabs = append(tabs, BackgroundTab{tab.ID, tab.Plugin, active})
		})
	}
	return tabs
}

// layoutTabs returns the tabs of the layouts of the window, with the plane in the place of the shown space, and the tabs that are shown.
func (s *Shell) layoutTabs() ([]MemorySurface, map[string]bool, error) {
	var surfaces []MemorySurface
	shown := map[string]bool{}
	err := s.eachLayoutTab(func(_ string, tab layout.Tab, active bool) {
		plugin := s.pluginOf(tab.Plugin)
		surfaces = append(surfaces, MemorySurface{ID: tab.ID, Plugin: tab.Plugin, Kind: "tab", Unload: plugin != nil && plugin.Unload})
		if active {
			shown[tab.ID] = true
		}
	})
	if err != nil {
		return nil, nil, err
	}
	for _, seat := range s.seatsInOrder() {
		surfaces = append(surfaces, MemorySurface{ID: seat.SurfaceID, Plugin: seat.Plugin, Kind: "section", Unload: seat.Unload != nil})
		if seat.Visible {
			shown[seat.SurfaceID] = true
		}
	}
	return surfaces, shown, nil
}

// eachLayoutTab visits the tabs of every space of the projects that the window opened, with the plane in the place of the shown space.
func (s *Shell) eachLayoutTab(visit func(project string, tab layout.Tab, active bool)) error {
	for _, project := range s.projects {
		if !s.windowProjects[project.ID] {
			continue
		}
		for _, space := range project.Spaces {
			if project.ID == s.active && space.ID == project.ActiveSpaceID {
				eachTab(s.plane.Cards(), func(tab layout.Tab, active bool) { visit(project.ID, tab, active) })
				continue
			}
			var stored storedLayout
			if err := json.Unmarshal(space.Layout, &stored); err != nil {
				return fmt.Errorf("space %s: %w", space.ID, err)
			}
			eachTab(stored.State.Cards, func(tab layout.Tab, _ bool) { visit(project.ID, tab, false) })
		}
	}
	return nil
}

// holdHiddenTabs holds a surface for each hidden tab that the memory saver left loaded, as the start mounts it: only a tab that starts
// unloaded and a tab of a plugin with a background session have no surface while hidden (docs/spec/plugins.md#memory-saver).
func (s *Shell) holdHiddenTabs() {
	if s.tabs == nil || !s.tabs.hiddenDue || !s.tabs.sectionsStarted || s.opened() == nil || s.plane == nil {
		return
	}
	s.tabs.hiddenDue = false
	err := s.eachLayoutTab(func(project string, tab layout.Tab, active bool) {
		unit := s.units[tab.Plugin]
		_, stopped := s.surfaces.stopped(tab.ID)
		if active || unit == nil || unit.Composition == nil || unit.Background != nil || stopped || s.surfaces.detachHeld(tab.ID) || s.tabs.saver.Unloaded(tab.ID) {
			return
		}
		s.holdSurface(&heldSurface{tab: tab, composition: unit.Composition, owner: project})
	})
	if err != nil {
		s.fail(err)
	}
}

// seatsInOrder returns the seats of the section surfaces of the last frame in the order of their ids.
func (s *Shell) seatsInOrder() []SidebarSeat {
	seats := make([]SidebarSeat, 0, len(s.surfaces.seated))
	for _, id := range slices.Sorted(maps.Keys(s.surfaces.seated)) {
		seats = append(seats, s.surfaces.seated[id])
	}
	return seats
}

// observeSections gives the memory saver the seats of a frame that changed them, because only a frame knows which section it shows. The
// first frame of a plane ends the start for the sections: the start of the tabs ran before any section had a seat
// (docs/spec/plugins.md#memory-saver).
func (s *Shell) observeSections() {
	if s.tabs == nil || s.surfaces.drawnPlane == nil || !s.tabs.started {
		return
	}
	lines := make([]string, 0, len(s.surfaces.seated))
	for _, seat := range s.seatsInOrder() {
		lines = append(lines, fmt.Sprintf("%s %t", seat.SurfaceID, seat.Visible))
	}
	if s.tabs.sectionsStarted && slices.Equal(lines, s.tabs.seats) {
		return
	}
	s.tabs.seats = lines
	if !s.observeMemory() {
		return
	}
	s.tabs.saver.Classify()
	if !s.tabs.sectionsStarted {
		s.tabs.sectionsStarted = true
		s.tabs.hiddenDue = true
	}
}

// tabsSettled brings these parts to the plane after each change of it.
func (s *Shell) tabsSettled() {
	if s.tabs == nil {
		return
	}
	if err := s.tabs.background.Sync(); err != nil {
		s.fail(err)
	}
	if !s.observeMemory() {
		return
	}
	s.tabs.hiddenDue = true
	s.tabs.started = true
	s.tabs.saver.Classify()
}

// observeMemory gives the memory saver the surfaces of the layouts of the window, and tells whether it took them.
func (s *Shell) observeMemory() bool {
	if s.opened() == nil || s.plane == nil || s.tabs.states == nil {
		return false
	}
	surfaces, shown, err := s.layoutTabs()
	if err == nil {
		err = s.tabs.saver.Observe(shown, surfaces)
	}
	if err != nil {
		s.fail(err)
		return false
	}
	return true
}

// droppedTabs removes the stored state and session of tabs and ends their sidecar sessions after the layout write that drops them is
// confirmed, so a refused write removes none.
func (s *Shell) droppedTabs(tabs []string) func() {
	s.forgetSurfaces(tabs)
	if len(tabs) == 0 {
		return func() {}
	}
	return func() {
		if s.tabs != nil {
			if s.tabs.states != nil {
				s.tabs.states.Remove(tabs, func() {})
			}
			s.tabs.sessions.Remove(tabs, func(err error) {
				if err != nil {
					s.fail(err)
				}
			})
		}
		s.retainSessions()
	}
}

// flushTabs writes the pending tab state and sessions and answers when both are written. The window runs it before it closes or
// reloads: the reads of the sessions and the writes are host calls of the window, which end with it.
func (s *Shell) flushTabs(answer func()) {
	if s.tabs == nil {
		answer()
		return
	}
	s.tabs.sessions.Flush(func() {
		if s.tabs.states == nil {
			answer()
			return
		}
		s.tabs.states.Flush(answer)
	})
}

// Closed ends these parts of a window that closed: no timer of them runs after it. It writes nothing: the window flushed them
// before its close, and a host call of a window that is gone fails.
func (s *Shell) Closed() {
	s.surfaces.closed = true
	if s.tabs != nil {
		s.tabs.closed = true
	}
}

// MemorySaver returns the memory saver of the window, or nil for a shell without tab ports. The surfaces report the end of a restore,
// a refused session history and a change of a protection to it.
func (s *Shell) MemorySaver() *MemorySaver {
	if s.tabs == nil {
		return nil
	}
	return s.tabs.saver
}

// TabSessions returns the tab sessions of the window, or nil for a shell without tab ports. The document regions report each document
// state and read the stored sessions through it.
func (s *Shell) TabSessions() *TabSessions {
	if s.tabs == nil {
		return nil
	}
	return s.tabs.sessions
}

// tabEvent handles an event of the host for these parts.
func (s *Shell) tabEvent(name string, data []any) {
	if s.tabs == nil || len(data) != 1 {
		return
	}
	var failure error
	switch name {
	case "sidecar-message":
		var message struct {
			Sidecar string          `json:"sidecar"`
			Surface string          `json:"surface"`
			Body    json.RawMessage `json:"body"`
		}
		if message, failure = decode[struct {
			Sidecar string          `json:"sidecar"`
			Surface string          `json:"surface"`
			Body    json.RawMessage `json:"body"`
		}](data[0]); failure == nil {
			s.tabs.sidecars.Message(message.Sidecar, message.Surface, message.Body)
		}
	case "sidecar-failure":
		var report struct {
			Sidecar string `json:"sidecar"`
			Surface string `json:"surface"`
			Reason  string `json:"reason"`
		}
		if report, failure = decode[struct {
			Sidecar string `json:"sidecar"`
			Surface string `json:"surface"`
			Reason  string `json:"reason"`
		}](data[0]); failure == nil {
			s.fail(fmt.Errorf("sidecar %s failed for surface %s: %s", report.Sidecar, report.Surface, report.Reason))
		}
	case "memory-pressure":
		var report MemoryPressure
		if report, failure = decode[MemoryPressure](data[0]); failure == nil {
			failure = s.tabs.saver.Pressure(report.Level, report.Seq)
		}
	}
	if failure != nil {
		s.fail(fmt.Errorf("%s: %w", name, failure))
	}
}

// shellFiles is the workspace of the file commands.
type shellFiles struct{ shell *Shell }

func (f shellFiles) HasProject() bool { return f.shell.opened() != nil && f.shell.plane != nil }

func (f shellFiles) FilePlugins() []FilePlugin {
	var plugins []FilePlugin
	for _, plugin := range f.shell.tabs.ports.Plugins() {
		plugins = append(plugins, FilePlugin{ID: plugin.ID, Opens: plugin.Opens})
	}
	return plugins
}

func tabPath(tab layout.Tab) string {
	var params struct {
		Path string `json:"path"`
	}
	if raw := tab.Rest["params"]; raw != nil && json.Unmarshal(raw, &params) != nil {
		return ""
	}
	return params.Path
}

func (f shellFiles) TabOfFile(plugin, file string) (card, tab string, found bool) {
	for _, each := range f.shell.plane.Cards() {
		data, err := layout.DecodeCardData(each.Data)
		if err != nil || data == nil {
			continue
		}
		for _, candidate := range data.TabList() {
			if candidate.Plugin == plugin && tabPath(candidate) == file {
				return each.ID, candidate.ID, true
			}
		}
	}
	return "", "", false
}

func (f shellFiles) SelectTab(tab string) error { return f.shell.selectTab(tab) }

func (f shellFiles) FocusedCard() string { return f.shell.focused }

func (f shellFiles) AddTab(card, plugin, file string) (string, error) {
	params, err := json.Marshal(map[string]string{"path": file})
	if err != nil {
		return "", err
	}
	return f.shell.addTab(card, plugin, params)
}
