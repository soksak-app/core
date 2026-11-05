package workbench

import (
	"cmp"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

const minuteMilliseconds = int64(60_000)

// memoryReasons is the order of the one enumeration of reasons (docs/spec/exposure.md#tab-memory).
var memoryReasons = []string{"shown", "recent", "keep:modified", "keep:busy", "media", "media-unknown", "capture", "form", "kept",
	"off", "undeclared", "background"}

// MemorySurface is a tab or a section surface of a loaded plugin as the memory saver reads it.
type MemorySurface struct {
	ID     string
	Plugin string
	// Kind is tab or section.
	Kind string
	// Unload tells whether the descriptor of the surface declares unload.
	Unload bool
}

// UnloadDeclaration returns the declaration of surface: background for a tab of a plugin with background, unload for a surface
// whose descriptor declares unload, otherwise undeclared (docs/spec/plugins.md#memory-saver).
func UnloadDeclaration(surface MemorySurface, background bool) string {
	switch {
	case background && surface.Kind == "tab":
		return "background"
	case surface.Unload:
		return "unload"
	}
	return "undeclared"
}

// MemorySaverPorts is what the memory saver uses. Every port and every answer runs in a step of the main thread, and an answer
// comes in the same step or in a later one.
type MemorySaverPorts struct {
	// Now returns the monotonic time in milliseconds.
	Now func() int64
	// Enabled and Delay read the settings memorySaver and memorySaverDelay (minutes).
	Enabled func() bool
	Delay   func() int
	// Declaration returns unload, undeclared or background for surface.
	Declaration func(surface MemorySurface) string
	// Keeps returns the keep reasons of the tab reports (keep:modified, keep:busy).
	Keeps func(tab string) []string
	// Kept reads the stored mark of tab, and SetKept stores it.
	Kept    func(tab string) bool
	SetKept func(tab string, on bool)
	// Regions answers with the reasons of the document regions of tab at a decision (media, media-unknown, capture, form).
	Regions func(tab string, answer func(reasons []string, err error))
	// Interaction stores the session history of the regions of tab before it is unloaded.
	Interaction func(tab string, answer func(err error))
	// Restore gives the regions of a restored tab the stored session history.
	Restore func(tab string)
	// Commit requests a commit and answers after host.place replied.
	Commit func(answer func(err error))
	// ShowLabel shows the cached label of a tab that starts unloaded.
	ShowLabel func(tab string)
	// Changed announces that the status changed.
	Changed func()
	// Failed shows a failed unload or restore through the error display.
	Failed func(text string)
	// StateChanged receives each change of the state of a tab (loaded, unloaded, restoring).
	StateChanged func(tab, state string)
	// Emit writes the event name with its level and fields to the log.
	Emit func(level, name string, fields map[string]any)
	// After runs run once in a later step after milliseconds and returns what cancels it.
	After func(milliseconds int64, run func()) (cancel func())
}

// MemoryPressure is the last memory pressure report of the host.
type MemoryPressure struct {
	Level string `json:"level"`
	Seq   int    `json:"seq"`
}

// MemoryTab is one surface of the status core.tab.memory.
type MemoryTab struct {
	Tab       string   `json:"tab"`
	Plugin    string   `json:"plugin"`
	Kind      string   `json:"kind"`
	State     string   `json:"state"`
	Reasons   []string `json:"reasons"`
	HiddenAt  *int64   `json:"hiddenAt"`
	UnloadAt  *int64   `json:"unloadAt"`
	CheckedAt *int64   `json:"checkedAt"`
}

// MemoryStatus is the memory saver part of the status core.tab.memory.
type MemoryStatus struct {
	Pressure MemoryPressure `json:"pressure"`
	Tabs     []MemoryTab    `json:"tabs"`
}

// MemoryPlacement splits the surfaces of a commit: Surfaces are those it declares to the host, Retain the ids it keeps, which
// include the unloaded tabs that stay in the layout, and Unload the ids whose surfaces it releases in the unload mode.
type MemoryPlacement struct {
	Surfaces []string
	Retain   map[string]bool
	Unload   []string
}

type memoryEntry struct {
	MemorySurface
	state                       string
	hiddenAt, shownAt, unloadAt *int64
	checkedAt                   *int64
	region                      []string
	generation                  int
	attempting                  bool
	// firstSeen tells that no classification has read the surface yet.
	firstSeen bool
}

// memoryOutcome ends an attempt: the reasons that ended it, empty when the tab was unloaded, or the error of a failed step.
type memoryOutcome struct {
	reasons []string
	err     error
}

// MemorySaver unloads a hidden tab after the delay or under memory pressure and restores it when the tab is shown again
// (docs/spec/plugins.md#memory-saver). Only this type decides when a tab is unloaded. It holds no lock, because all of its work
// runs in steps of the main thread.
type MemorySaver struct {
	ports    MemorySaverPorts
	entries  map[string]*memoryEntry
	order    []*memoryEntry
	cancel   func()
	pressure MemoryPressure
	pressing bool
}

// NewMemorySaver returns a memory saver over ports.
func NewMemorySaver(ports MemorySaverPorts) *MemorySaver {
	return &MemorySaver{ports: ports, entries: map[string]*memoryEntry{}, pressure: MemoryPressure{Level: "normal"}}
}

func (s *MemorySaver) delayMilliseconds() int64 { return int64(s.ports.Delay()) * minuteMilliseconds }

// sorted returns the set reasons in the order of the enumeration, and an empty list for none.
func sorted(reasons map[string]bool) []string {
	list := []string{}
	for _, reason := range memoryReasons {
		if reasons[reason] {
			list = append(list, reason)
		}
	}
	return list
}

// reasonsOf returns the reasons that protect entry. Under pressure recent does not protect.
func (s *MemorySaver) reasonsOf(entry *memoryEntry, underPressure, region bool) []string {
	reasons := map[string]bool{}
	if kind := s.ports.Declaration(entry.MemorySurface); kind != "unload" {
		reasons[kind] = true
	}
	if !s.ports.Enabled() {
		reasons["off"] = true
	}
	if entry.hiddenAt == nil {
		reasons["shown"] = true
	} else if !underPressure && entry.shownAt != nil && s.ports.Now()-*entry.shownAt < s.delayMilliseconds() {
		reasons["recent"] = true
	}
	for _, reason := range s.ports.Keeps(entry.ID) {
		reasons[reason] = true
	}
	if s.ports.Kept(entry.ID) {
		reasons["kept"] = true
	}
	if region {
		for _, reason := range entry.region {
			reasons[reason] = true
		}
	}
	return sorted(reasons)
}

// standing returns the reasons that a decision does not read: an entry without them is a candidate.
func (s *MemorySaver) standing(entry *memoryEntry, underPressure bool) []string {
	return slices.DeleteFunc(s.reasonsOf(entry, underPressure, false), func(reason string) bool { return reason == "recent" })
}

// deadline returns the moved deadline of entry, or for a tab without one the time one delay after it was hidden.
func (s *MemorySaver) deadline(entry *memoryEntry) int64 {
	if entry.unloadAt != nil {
		return *entry.unloadAt
	}
	return *entry.hiddenAt + s.delayMilliseconds()
}

// scheduled tells whether the delay may unload entry.
func (s *MemorySaver) scheduled(entry *memoryEntry) bool {
	return entry.state == "loaded" && entry.hiddenAt != nil && !entry.attempting && len(s.standing(entry, false)) == 0
}

// arm holds one timer for the earliest deadline, because elapsed time has no event source. It runs on a show or a hide, a
// protection change and a setting change.
func (s *MemorySaver) arm() {
	s.ports.Changed()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	if !s.ports.Enabled() {
		return
	}
	var earliest *int64
	for _, entry := range s.order {
		if !s.scheduled(entry) {
			continue
		}
		if due := s.deadline(entry); earliest == nil || due < *earliest {
			earliest = &due
		}
	}
	if earliest != nil {
		s.cancel = s.ports.After(max(0, *earliest-s.ports.Now()), s.fire)
	}
}

func (s *MemorySaver) fire() {
	s.cancel = nil
	var due []*memoryEntry
	for _, entry := range s.order {
		if s.scheduled(entry) && s.deadline(entry) <= s.ports.Now() {
			due = append(due, entry)
		}
	}
	var next func(index int)
	next = func(index int) {
		if index == len(due) {
			s.arm()
			return
		}
		s.attempt(due[index], "delay", false, false, func(memoryOutcome) { next(index + 1) })
	}
	next(0)
}

func (s *MemorySaver) setState(entry *memoryEntry, state string) {
	entry.state = state
	s.ports.StateChanged(entry.ID, state)
	s.ports.Changed()
}

func (s *MemorySaver) skipped(trigger string, reasons []string) {
	s.ports.Emit("info", "workbench.tab.unload.skipped", map[string]any{"trigger": trigger, "seq": s.pressure.Seq, "reasons": reasons})
}

// attempt is one unload attempt with its generation: a show increments the generation, and after every step that answers later
// the protections are evaluated again before the tab is marked unloaded. The command does not wait for recent and the reasons of
// the regions, because it is the decision of the person (docs/spec/exposure.md#tab-memory).
func (s *MemorySaver) attempt(entry *memoryEntry, trigger string, underPressure, command bool, done func(memoryOutcome)) {
	entry.attempting = true
	generation := entry.generation
	finish := func(outcome memoryOutcome) {
		entry.attempting = false
		done(outcome)
	}
	fail := func(err error) { finish(memoryOutcome{err: s.unloadFailed(entry, trigger, err)}) }
	ended := func() []string {
		if s.entries[entry.ID] != entry {
			return []string{"shown"}
		}
		reasons := s.standing(entry, underPressure)
		if generation != entry.generation && !slices.Contains(reasons, "shown") {
			reasons = slices.Insert(reasons, 0, "shown")
		}
		return reasons
	}
	skip := func(reasons []string) {
		s.skipped(trigger, reasons)
		finish(memoryOutcome{reasons: reasons})
	}
	s.ports.Regions(entry.ID, func(region []string, err error) {
		if err != nil {
			fail(err)
			return
		}
		entry.region = region
		checked := s.ports.Now()
		entry.checkedAt = &checked
		if reasons := ended(); len(reasons) > 0 {
			skip(reasons)
			return
		}
		if len(entry.region) > 0 && !command {
			// A tab that the regions protect at its deadline gets its next deadline one delay later.
			if trigger == "delay" {
				s.postpone(entry)
			}
			finish(memoryOutcome{reasons: entry.region})
			return
		}
		s.ports.Interaction(entry.ID, func(err error) {
			if err != nil {
				fail(err)
				return
			}
			if reasons := ended(); len(reasons) > 0 {
				skip(reasons)
				return
			}
			s.setState(entry, "unloaded")
			entry.unloadAt = nil
			s.ports.Commit(func(err error) {
				if err != nil {
					// A commit that fails after the tab is marked returns the tab to loaded, and the next commit declares its surface.
					s.setState(entry, "loaded")
					s.ports.Commit(func(again error) {
						if again != nil {
							s.ports.Failed(fmt.Sprintf("memory saver: tab %s: commit failed: %s", entry.ID, again))
						}
					})
					fail(err)
					return
				}
				s.ports.Emit("info", "workbench.tab.unloaded", map[string]any{"tab": entry.ID, "plugin": entry.Plugin, "trigger": trigger})
				finish(memoryOutcome{})
			})
		})
	})
}

func (s *MemorySaver) postpone(entry *memoryEntry) {
	next := s.ports.Now() + s.delayMilliseconds()
	entry.unloadAt = &next
}

// unloadFailed ends an attempt with a failed read of the regions or a failed commit with the tab loaded. The next attempt of the
// delay comes one delay later, so a read that keeps failing does not run again at the deadline that already passed.
func (s *MemorySaver) unloadFailed(entry *memoryEntry, trigger string, err error) error {
	if trigger == "delay" {
		s.postpone(entry)
	}
	s.ports.Emit("error", "workbench.tab.unload.failed", map[string]any{"tab": entry.ID, "plugin": entry.Plugin, "trigger": trigger, "reason": err.Error()})
	s.ports.Failed(fmt.Sprintf("memory saver: tab %s: unload failed: %s", entry.ID, err))
	return err
}

// relieve unloads, while the level is warn or critical, one candidate at a time, least recently shown first, after the previous
// unload ends, until a normal report or until no candidate remains.
func (s *MemorySaver) relieve() {
	if s.pressing {
		return
	}
	s.pressing = true
	end := func() {
		s.pressing = false
		s.arm()
	}
	var round func()
	round = func() {
		if s.pressure.Level == "normal" || !s.ports.Enabled() {
			end()
			return
		}
		seq := s.pressure.Seq
		var candidates []*memoryEntry
		for _, entry := range s.order {
			if entry.state == "loaded" && !entry.attempting && len(s.standing(entry, true)) == 0 {
				candidates = append(candidates, entry)
			}
		}
		// A tab that was never shown goes first.
		slices.SortStableFunc(candidates, func(a, b *memoryEntry) int {
			switch {
			case a.shownAt == nil && b.shownAt == nil:
				return 0
			case a.shownAt == nil:
				return -1
			case b.shownAt == nil:
				return 1
			}
			return cmp.Compare(*a.shownAt, *b.shownAt)
		})
		var next func(index int)
		next = func(index int) {
			if index == len(candidates) {
				reasons := map[string]bool{}
				for _, entry := range s.order {
					if entry.state == "loaded" {
						for _, reason := range s.reasonsOf(entry, true, true) {
							reasons[reason] = true
						}
					}
				}
				s.ports.Emit("info", "workbench.tab.unload.skipped", map[string]any{"trigger": "pressure", "seq": seq, "reasons": sorted(reasons)})
				end()
				return
			}
			if s.pressure.Level == "normal" {
				end()
				return
			}
			s.attempt(candidates[index], "pressure", true, false, func(outcome memoryOutcome) {
				if outcome.err == nil && len(outcome.reasons) == 0 {
					round()
					return
				}
				next(index + 1)
			})
		}
		next(0)
	}
	round()
}

// Observe takes the tabs of every layout and the section surfaces of loaded plugins and the ids of the shown ones at a commit. A
// tab seen first while hidden takes this time as its hidden time, and showing an unloaded tab restores it.
func (s *MemorySaver) Observe(shown map[string]bool, surfaces []MemorySurface) error {
	for _, surface := range surfaces {
		if surface.Kind != "tab" && surface.Kind != "section" {
			return fmt.Errorf("memory saver: surface %s has kind %s", surface.ID, surface.Kind)
		}
	}
	time := s.ports.Now()
	entries := make(map[string]*memoryEntry, len(surfaces))
	order := make([]*memoryEntry, 0, len(surfaces))
	for _, surface := range surfaces {
		entry := s.entries[surface.ID]
		isShown := shown[surface.ID]
		switch {
		case entry == nil:
			entry = &memoryEntry{MemorySurface: surface, state: "loaded", firstSeen: true}
			if isShown {
				entry.shownAt = &time
			} else {
				entry.hiddenAt = &time
			}
		case isShown && entry.hiddenAt != nil:
			entry.hiddenAt = nil
			entry.shownAt = &time
			entry.unloadAt = nil
			entry.region = nil
			entry.generation++
			if entry.state == "unloaded" {
				s.setState(entry, "restoring")
				s.ports.Restore(surface.ID)
			}
		case isShown:
			entry.shownAt = &time
		case entry.hiddenAt == nil:
			entry.hiddenAt = &time
		}
		entries[surface.ID] = entry
		order = append(order, entry)
	}
	s.entries, s.order = entries, order
	s.arm()
	return nil
}

// Classify classifies the surfaces first seen since the last call: while the setting is on, a hidden surface that declares unload and
// was never shown starts unloaded and shows its cached label, so it never mounts only to unload. A surface first seen while the
// setting is off stays and waits for the delay (docs/spec/plugins.md#memory-saver).
func (s *MemorySaver) Classify() {
	var seen []*memoryEntry
	for _, entry := range s.order {
		if entry.firstSeen {
			entry.firstSeen = false
			seen = append(seen, entry)
		}
	}
	if !s.ports.Enabled() {
		return
	}
	changed := false
	for _, entry := range seen {
		if entry.state != "loaded" || entry.hiddenAt == nil || entry.shownAt != nil || s.ports.Declaration(entry.MemorySurface) != "unload" {
			continue
		}
		s.setState(entry, "unloaded")
		s.ports.ShowLabel(entry.ID)
		changed = true
	}
	s.arm()
	if changed {
		s.ports.Commit(func(err error) {
			if err != nil {
				s.ports.Failed(fmt.Sprintf("memory saver commit: %s", err))
			}
		})
	}
}

// Pressure takes a memory pressure report of the host.
func (s *MemorySaver) Pressure(level string, seq int) error {
	if level != "normal" && level != "warn" && level != "critical" {
		report, err := json.Marshal(MemoryPressure{level, seq})
		if err != nil {
			return err
		}
		return fmt.Errorf("memory pressure report %s is not {level, seq}", report)
	}
	s.pressure = MemoryPressure{level, seq}
	s.ports.Changed()
	if level != "normal" {
		s.relieve()
	}
	return nil
}

// SettingsChanged re-arms the scheduler after a setting changed.
func (s *MemorySaver) SettingsChanged() {
	s.arm()
	if s.pressure.Level != "normal" {
		s.relieve()
	}
}

// ProtectionsChanged re-arms the scheduler after a protection of a tab report or the mark changed.
func (s *MemorySaver) ProtectionsChanged() { s.arm() }

// Known tells whether the memory saver knows tab.
func (s *MemorySaver) Known(tab string) bool { return s.entries[tab] != nil }

// Tab checks the id of a known tab for core.tab.unload, core.tab.keep and core.tab.menu. A section surface id is refused, so only
// the memory saver unloads a section (docs/spec/plugins.md#memory-saver).
func (s *MemorySaver) Tab(id string) error {
	entry := s.entries[id]
	if entry == nil {
		quoted, err := json.Marshal(id)
		if err != nil {
			return err
		}
		return fmt.Errorf("unknown tab %s", quoted)
	}
	if entry.Kind == "section" {
		return fmt.Errorf("%s is a section surface, not a tab", id)
	}
	return nil
}

// Unload unloads a hidden tab now (core.tab.unload). It does not wait for recent and the reasons of the regions, and it refuses
// the other reasons and the reasons that ended the attempt with `tab <id> is protected: <reasons>`.
func (s *MemorySaver) Unload(tab string, answer func(err error)) {
	entry := s.entries[tab]
	if entry == nil {
		answer(fmt.Errorf("unknown tab %s", tab))
		return
	}
	if entry.state == "unloaded" {
		answer(nil)
		return
	}
	refuse := func(reasons []string) error {
		return fmt.Errorf("tab %s is protected: %s", tab, strings.Join(reasons, ", "))
	}
	if before := s.standing(entry, true); len(before) > 0 {
		answer(refuse(before))
		return
	}
	s.attempt(entry, "command", true, true, func(outcome memoryOutcome) {
		s.arm()
		switch {
		case outcome.err != nil:
			answer(outcome.err)
		case len(outcome.reasons) > 0:
			answer(refuse(outcome.reasons))
		default:
			answer(nil)
		}
	})
}

// Keep sets or clears the mark kept of tab (core.tab.keep) with one workbench.tab.keep.changed per change. A tab that can never be
// unloaded is refused.
func (s *MemorySaver) Keep(tab string, on bool) error {
	entry := s.entries[tab]
	if entry == nil {
		return fmt.Errorf("unknown tab %s", tab)
	}
	if kind := s.ports.Declaration(entry.MemorySurface); kind != "unload" {
		return fmt.Errorf("tab %s can never be unloaded: %s", tab, kind)
	}
	if s.ports.Kept(tab) == on {
		return nil
	}
	s.ports.SetKept(tab, on)
	s.ports.Emit("info", "workbench.tab.keep.changed", map[string]any{"tab": tab, "keep": on})
	s.arm()
	return nil
}

// Status returns the last pressure report and each tab.
func (s *MemorySaver) Status() MemoryStatus {
	tabs := make([]MemoryTab, 0, len(s.order))
	for _, entry := range s.order {
		tab := MemoryTab{Tab: entry.ID, Plugin: entry.Plugin, Kind: entry.Kind, State: entry.state, Reasons: s.reasonsOf(entry, false, true),
			HiddenAt: entry.hiddenAt, CheckedAt: entry.checkedAt}
		// A tab without a next deadline (shown, unloaded, or protected by a standing reason) has none.
		if entry.state == "loaded" && entry.hiddenAt != nil && s.ports.Enabled() && len(s.standing(entry, false)) == 0 {
			due := s.deadline(entry)
			tab.UnloadAt = &due
		}
		tabs = append(tabs, tab)
	}
	return MemoryStatus{Pressure: s.pressure, Tabs: tabs}
}

// Restored ends the restore of a tab whose surface mounted. history tells whether a region of it restored a session history.
func (s *MemorySaver) Restored(tab string, history bool) error {
	entry := s.entries[tab]
	if entry == nil || entry.state != "restoring" {
		return fmt.Errorf("tab %s is not restoring", tab)
	}
	s.setState(entry, "loaded")
	s.ports.Emit("info", "workbench.tab.restored", map[string]any{"tab": tab, "plugin": entry.Plugin, "history": history})
	return nil
}

// RestoreFailed ends the restore of a tab whose surface or region refused it, and shows the failure
// (docs/spec/plugins.md#memory-saver).
func (s *MemorySaver) RestoreFailed(tab, reason string) error {
	entry := s.entries[tab]
	if entry == nil {
		return fmt.Errorf("unknown tab %s", tab)
	}
	if entry.state == "restoring" {
		s.setState(entry, "loaded")
	}
	s.reportRestore(tab, entry.Plugin, reason)
	return nil
}

// HistoryRefused reports a document region of a tab of plugin that refused its restored session history. The region attaches
// again without it, so a restore stays open and the end of the mount still emits workbench.tab.restored
// (docs/spec/plugins.md#memory-saver). The first show of a tab after a restart restores a session history before any commit gives
// the tab to the memory saver, so the tab need not be known.
func (s *MemorySaver) HistoryRefused(tab, plugin, reason string) {
	s.reportRestore(tab, plugin, reason)
}

func (s *MemorySaver) reportRestore(tab, plugin, reason string) {
	s.ports.Emit("error", "workbench.tab.restore.failed", map[string]any{"tab": tab, "plugin": plugin, "reason": reason})
	s.ports.Failed(fmt.Sprintf("memory saver: tab %s: restore failed: %s", tab, reason))
}

// State returns the state of tab: loaded, unloaded or restoring, and empty for a tab that no commit gave the memory saver yet.
func (s *MemorySaver) State(tab string) string {
	if entry := s.entries[tab]; entry != nil {
		return entry.state
	}
	return ""
}

// Unloaded tells whether tab is unloaded.
func (s *MemorySaver) Unloaded(tab string) bool { return s.State(tab) == "unloaded" }

// Reasons returns the reasons that protect tab now.
func (s *MemorySaver) Reasons(tab string) ([]string, error) {
	entry := s.entries[tab]
	if entry == nil {
		return nil, fmt.Errorf("unknown tab %s", tab)
	}
	return s.reasonsOf(entry, false, true), nil
}

// Place splits the surface ids of a commit.
func (s *MemorySaver) Place(surfaces []string) MemoryPlacement {
	placement := MemoryPlacement{Retain: make(map[string]bool, len(surfaces)), Unload: []string{}}
	for _, entry := range s.order {
		if entry.state == "unloaded" {
			placement.Unload = append(placement.Unload, entry.ID)
			placement.Retain[entry.ID] = true
		}
	}
	for _, id := range surfaces {
		placement.Retain[id] = true
		if !slices.Contains(placement.Unload, id) {
			placement.Surfaces = append(placement.Surfaces, id)
		}
	}
	return placement
}

// memoryParams is the parameters of core.tab.unload and core.tab.keep. tab stays raw, because a tab that is not a string is
// refused with its JSON.
type memoryParams struct {
	Tab  json.RawMessage `json:"tab"`
	Keep json.RawMessage `json:"keep"`
}

// memoryTab returns the tab of a core.tab command: a string that the memory saver knows, otherwise invalid params.
func (s *MemorySaver) memoryTab(raw json.RawMessage) (string, error) {
	var tab *string
	if len(raw) == 0 {
		return "", Refuse(InvalidParams, "unknown tab undefined")
	}
	if err := json.Unmarshal(raw, &tab); err != nil || tab == nil {
		return "", Refuse(InvalidParams, "unknown tab %s", raw)
	}
	if err := s.Tab(*tab); err != nil {
		return "", Refuse(InvalidParams, "%s", err)
	}
	return *tab, nil
}

func decodeMemoryParams(params json.RawMessage) (memoryParams, error) {
	var decoded memoryParams
	if len(params) == 0 {
		return decoded, nil
	}
	if err := json.Unmarshal(params, &decoded); err != nil {
		return decoded, Refuse(InvalidParams, "%s", err)
	}
	return decoded, nil
}

// RegisterMemorySaver registers core.tab.memory, core.tab.unload and core.tab.keep over saver. enabled and delay read the settings
// memorySaver and memorySaverDelay.
func RegisterMemorySaver(registry *Registry, saver *MemorySaver, enabled func() bool, delay func() int) {
	registry.Status("core.tab.memory", func() any {
		status := saver.Status()
		return struct {
			Enabled  bool           `json:"enabled"`
			Delay    int            `json:"delay"`
			Pressure MemoryPressure `json:"pressure"`
			Tabs     []MemoryTab    `json:"tabs"`
		}{enabled(), delay(), status.Pressure, status.Tabs}
	})
	registry.CommandLater("core.tab.unload", func(params json.RawMessage, answer func(any, error)) {
		decoded, err := decodeMemoryParams(params)
		if err != nil {
			answer(nil, err)
			return
		}
		tab, err := saver.memoryTab(decoded.Tab)
		if err != nil {
			answer(nil, err)
			return
		}
		saver.Unload(tab, func(err error) { answer(nil, err) })
	})
	registry.Command("core.tab.keep", func(params json.RawMessage) (any, error) {
		decoded, err := decodeMemoryParams(params)
		if err != nil {
			return nil, err
		}
		tab, err := saver.memoryTab(decoded.Tab)
		if err != nil {
			return nil, err
		}
		var keep *bool
		if len(decoded.Keep) == 0 || json.Unmarshal(decoded.Keep, &keep) != nil || keep == nil {
			return nil, Refuse(InvalidParams, "keep must be a boolean")
		}
		return nil, saver.Keep(tab, *keep)
	})
}
