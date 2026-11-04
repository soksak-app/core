package workbench

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
)

const (
	tabStateFile   = "tab-state.json"
	tabStateFormat = 1
	// tabCoalesceMilliseconds is the shortest time between two coalesced writes of one tab.
	tabCoalesceMilliseconds = int64(1000)
	// SessionLimit is the largest decoded session of one region that is stored, in bytes.
	SessionLimit = 1024 * 1024
)

// TabEntry is the entry of a tab in tab-state.json (docs/spec/projects.md#persistence).
type TabEntry struct {
	// State is the state {format, value} that the plugin of the tab wrote.
	State json.RawMessage `json:"state,omitempty"`
	Kept  bool            `json:"kept,omitempty"`
	Label *string         `json:"label,omitempty"`
}

func (e TabEntry) empty() bool { return e.State == nil && !e.Kept && e.Label == nil }

// TabRegionSession is the stored session of one document region of a tab.
type TabRegionSession struct {
	Session string `json:"session"`
}

// TabStateStore is the part of the workspace call that the tab state store uses. A write answers after the earlier writes.
type TabStateStore interface {
	// TabState answers with the document of tab-state.json, which is empty for a missing file.
	TabState(answer func(document json.RawMessage, err error))
	// TabStatePut stores entry, and a nil entry removes the entry of tab. It answers with the size of the file.
	TabStatePut(tab string, entry *TabEntry, answer func(bytes int, err error))
}

// TabSessionStore is the part of the workspace call that the tab sessions use. A write answers after the earlier writes.
type TabSessionStore interface {
	// TabSession answers with the document of the session file of tab, which is empty for a tab without a file.
	TabSession(tab string, answer func(document json.RawMessage, err error))
	// TabSessionPut stores regions, and nil removes the file of tab. It answers with the size of the file.
	TabSessionPut(tab string, regions map[string]TabRegionSession, answer func(bytes int, err error))
	// TabSessions answers with the tabs that have a session file.
	TabSessions(answer func(tabs []string, err error))
}

// HostTabStore is both stores over the workspace kinds of the host (docs/spec/native-host.md). The writes of each file kind run in
// the order of the calls.
type HostTabStore struct {
	Calls *Calls
}

func documentAnswer(answer func(json.RawMessage, error)) func(any, error) {
	return func(value any, err error) {
		if err != nil || value == nil {
			answer(nil, err)
			return
		}
		document, err := json.Marshal(value)
		answer(document, err)
	}
}

func sizeAnswer(answer func(int, error)) func(any, error) {
	return func(value any, err error) {
		if err != nil || value == nil {
			answer(0, err)
			return
		}
		bytes, ok := value.(int)
		if !ok {
			answer(0, fmt.Errorf("workspace answered with %T, not a size", value))
			return
		}
		answer(bytes, nil)
	}
}

// TabState implements TabStateStore.
func (s HostTabStore) TabState(answer func(json.RawMessage, error)) {
	s.Calls.Call("workspace", map[string]any{"kind": "tabState"}, documentAnswer(answer))
}

// TabStatePut implements TabStateStore.
func (s HostTabStore) TabStatePut(tab string, entry *TabEntry, answer func(int, error)) {
	s.Calls.CallInOrder("tab state", "workspace", map[string]any{"kind": "tabStatePut", "tab": tab, "entry": entry}, sizeAnswer(answer))
}

// TabSession implements TabSessionStore.
func (s HostTabStore) TabSession(tab string, answer func(json.RawMessage, error)) {
	s.Calls.Call("workspace", map[string]any{"kind": "tabSession", "tab": tab}, documentAnswer(answer))
}

// TabSessionPut implements TabSessionStore.
func (s HostTabStore) TabSessionPut(tab string, regions map[string]TabRegionSession, answer func(int, error)) {
	s.Calls.CallInOrder("tab session", "workspace", map[string]any{"kind": "tabSessionPut", "tab": tab, "regions": regions}, sizeAnswer(answer))
}

// TabSessions implements TabSessionStore.
func (s HostTabStore) TabSessions(answer func([]string, error)) {
	s.Calls.Call("workspace", map[string]any{"kind": "tabSessions"}, func(value any, err error) {
		if err != nil {
			answer(nil, err)
			return
		}
		tabs, ok := value.([]string)
		if !ok {
			answer(nil, fmt.Errorf("workspace answered with %T, not the session tabs", value))
			return
		}
		answer(tabs, nil)
	})
}

// tabWrites counts the store writes of a store, so a caller can wait for the writes started so far. Writes answer in the order they
// started.
type tabWrites struct {
	started, ended int
	waiting        []tabWriteWaiter
}

type tabWriteWaiter struct {
	until int
	run   func()
}

func (w *tabWrites) start() { w.started++ }

func (w *tabWrites) end() {
	w.ended++
	for len(w.waiting) > 0 && w.waiting[0].until <= w.ended {
		run := w.waiting[0].run
		w.waiting = w.waiting[1:]
		run()
	}
}

// idle runs run when the writes started so far have ended.
func (w *tabWrites) idle(run func()) {
	if w.ended >= w.started {
		run()
		return
	}
	w.waiting = append(w.waiting, tabWriteWaiter{w.started, run})
}

// pendingTabs is the coalescing timers of the tabs.
type pendingTabs map[string]func()

func (p pendingTabs) cancel(tab string) {
	if cancel := p[tab]; cancel != nil {
		cancel()
		delete(p, tab)
	}
}

func (p pendingTabs) sorted() []string { return slices.Sorted(maps.Keys(p)) }

// CheckTabStateDocument returns the entries of a stored document, none for a missing file, and refuses a document of another format.
func CheckTabStateDocument(document json.RawMessage) (map[string]TabEntry, error) {
	if len(document) == 0 || string(document) == "null" {
		return map[string]TabEntry{}, nil
	}
	var stored struct {
		Format json.RawMessage `json:"format"`
		Tabs   json.RawMessage `json:"tabs"`
	}
	if err := json.Unmarshal(document, &stored); err != nil {
		return nil, fmt.Errorf("%s: %w", tabStateFile, err)
	}
	if stored.Format == nil {
		return nil, fmt.Errorf("%s: tab state format missing is not %d", tabStateFile, tabStateFormat)
	}
	if string(stored.Format) != fmt.Sprint(tabStateFormat) {
		return nil, fmt.Errorf("%s: tab state format %s is not %d", tabStateFile, stored.Format, tabStateFormat)
	}
	tabs := map[string]TabEntry{}
	if !strings.HasPrefix(string(stored.Tabs), "{") {
		return nil, fmt.Errorf("%s: tab state tabs is not an object", tabStateFile)
	}
	if err := json.Unmarshal(stored.Tabs, &tabs); err != nil {
		return nil, fmt.Errorf("%s: %w", tabStateFile, err)
	}
	return tabs, nil
}

// TabStatePorts is what the tab state store uses. Every port and every answer runs in a step of the main thread.
type TabStatePorts struct {
	Store TabStateStore
	// Failed shows a failed write through the error display.
	Failed func(text string)
	// UnloadOf tells whether plugin declares surface.unload.
	UnloadOf func(plugin string) bool
	Emit     func(level, name string, fields map[string]any)
	After    func(milliseconds int64, run func()) (cancel func())
}

// TabStates is the tab state store tab-state.json of the memory saver (docs/spec/projects.md#persistence,
// docs/spec/plugins.md#memory-saver). The entries live in memory, and the store writes the entry of a tab at most once per second
// and at quit.
type TabStates struct {
	ports   TabStatePorts
	entries map[string]TabEntry
	pending pendingTabs
	writes  tabWrites
}

// OpenTabStates reads the store and answers with its entries.
func OpenTabStates(ports TabStatePorts, answer func(states *TabStates, err error)) {
	ports.Store.TabState(func(document json.RawMessage, err error) {
		if err != nil {
			answer(nil, err)
			return
		}
		entries, err := CheckTabStateDocument(document)
		if err != nil {
			answer(nil, err)
			return
		}
		answer(&TabStates{ports: ports, entries: entries, pending: pendingTabs{}}, nil)
	})
}

func (s *TabStates) put(tab string) {
	var entry *TabEntry
	if stored, found := s.entries[tab]; found {
		entry = &stored
	}
	s.writes.start()
	s.ports.Store.TabStatePut(tab, entry, func(bytes int, err error) {
		if err != nil {
			s.ports.Failed(fmt.Sprintf("tab state of %s: %s", tab, err))
		} else {
			s.ports.Emit("debug", "workbench.tab.state.stored", map[string]any{"tab": tab, "bytes": bytes})
		}
		s.writes.end()
	})
}

func (s *TabStates) schedule(tab string) {
	if s.pending[tab] != nil {
		return
	}
	s.pending[tab] = s.ports.After(tabCoalesceMilliseconds, func() {
		delete(s.pending, tab)
		s.put(tab)
	})
}

// change sets the fields of the entry of tab, and an entry without fields is removed.
func (s *TabStates) change(tab string, set func(entry *TabEntry)) {
	entry := s.entries[tab]
	set(&entry)
	if entry.empty() {
		delete(s.entries, tab)
	} else {
		s.entries[tab] = entry
	}
	s.schedule(tab)
}

func (s *TabStates) remove(tab string) {
	s.pending.cancel(tab)
	delete(s.entries, tab)
	s.put(tab)
}

// Entry returns the entry of tab, and false for a tab without one.
func (s *TabStates) Entry(tab string) (TabEntry, bool) {
	entry, found := s.entries[tab]
	return entry, found
}

// Label returns the cached label of tab, or nil.
func (s *TabStates) Label(tab string) *string { return s.entries[tab].Label }

// Kept reads the mark kept of tab.
func (s *TabStates) Kept(tab string) bool { return s.entries[tab].Kept }

// Write stores the state {format, value} that the plugin of tab wrote.
func (s *TabStates) Write(tab string, state json.RawMessage) {
	s.change(tab, func(entry *TabEntry) { entry.State = state })
}

// SetKept sets or clears the mark kept of tab.
func (s *TabStates) SetKept(tab string, kept bool) {
	s.change(tab, func(entry *TabEntry) { entry.Kept = kept })
}

// CacheLabel keeps the reported title of tab as its label when its plugin declares surface.unload, and nil removes it.
func (s *TabStates) CacheLabel(tab, plugin string, label *string) {
	if s.ports.UnloadOf(plugin) {
		s.change(tab, func(entry *TabEntry) { entry.Label = label })
	}
}

// Remove removes the entries of tabs. The caller runs it after the layout write that drops them is confirmed, so a refused write
// removes none.
func (s *TabStates) Remove(tabs []string, answer func()) {
	for _, tab := range tabs {
		_, found := s.entries[tab]
		if found || s.pending[tab] != nil {
			s.remove(tab)
		}
	}
	s.writes.idle(answer)
}

// Reconcile removes each entry that kept does not keep, with an event per entry.
func (s *TabStates) Reconcile(kept func(tab string) bool, answer func()) {
	for _, tab := range slices.Sorted(maps.Keys(s.entries)) {
		if !kept(tab) {
			s.ports.Emit("info", "workbench.tab.state.orphan", map[string]any{"tab": tab})
			s.remove(tab)
		}
	}
	s.writes.idle(answer)
}

// Flush writes every pending entry now. The window calls it at quit.
func (s *TabStates) Flush(answer func()) {
	for _, tab := range s.pending.sorted() {
		s.pending.cancel(tab)
		s.put(tab)
	}
	s.writes.idle(answer)
}

// TabHistoryEntry is one entry of the history of a document state.
type TabHistoryEntry struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

// TabHistory is the history of a document state of a region.
type TabHistory struct {
	Entries []TabHistoryEntry `json:"entries"`
	Index   int               `json:"index"`
}

// DecodedBytes returns the decoded size in bytes of a base64 text.
func DecodedBytes(text string) int {
	padding := 0
	if strings.HasSuffix(text, "==") {
		padding = 2
	} else if strings.HasSuffix(text, "=") {
		padding = 1
	}
	return len(text)*3/4 - padding
}

// TabSessionPorts is what the tab sessions use. Every port and every answer runs in a step of the main thread.
type TabSessionPorts struct {
	Store TabSessionStore
	// Interaction answers with the interactionState of each region of tab that yields one, or nil when none does.
	Interaction func(tab string, answer func(history map[string]string, err error))
	// Tabs lists the tabs that have attached regions.
	Tabs func() []string
	// Failed shows a failed write through the error display.
	Failed func(text string)
	Emit   func(level, name string, fields map[string]any)
	After  func(milliseconds int64, run func()) (cancel func())
}

// TabSessions is the tab sessions tab-sessions/<tab>.json (docs/spec/projects.md#persistence, docs/spec/plugins.md#memory-saver): the
// session history of each document region of a tab. The session of a tab is written at a main-frame navigation commit of a region,
// at most once per second per tab, at unload and at quit. Each tab has its own file, so a write rewrites no other tab.
type TabSessions struct {
	ports   TabSessionPorts
	pending pendingTabs
	// histories holds, per tab and region name, the history of the last document state of the region as JSON.
	histories map[string]map[string]string
	// removed holds the tabs whose file was removed: a tab id is never issued again, so a later state of a closing region writes
	// nothing.
	removed map[string]bool
	writes  tabWrites
}

// NewTabSessions returns the tab sessions over ports.
func NewTabSessions(ports TabSessionPorts) *TabSessions {
	return &TabSessions{ports: ports, pending: pendingTabs{}, histories: map[string]map[string]string{}, removed: map[string]bool{}}
}

func (s *TabSessions) put(tab string, regions map[string]TabRegionSession, answer func(err error)) {
	s.writes.start()
	s.ports.Store.TabSessionPut(tab, regions, func(bytes int, err error) {
		if err == nil && regions != nil {
			s.ports.Emit("debug", "workbench.tab.session.stored", map[string]any{"tab": tab, "bytes": bytes})
		}
		answer(err)
		s.writes.end()
	})
}

// Capture writes the session of tab now, which stores the regions of at most SessionLimit bytes. A tab without regions writes
// nothing. The memory saver calls it before an unload, and a failure fails the unload.
func (s *TabSessions) Capture(tab string, answer func(err error)) {
	s.pending.cancel(tab)
	if s.removed[tab] {
		answer(nil)
		return
	}
	s.ports.Interaction(tab, func(history map[string]string, err error) {
		if err != nil || history == nil || s.removed[tab] {
			answer(err)
			return
		}
		var regions map[string]TabRegionSession
		for _, region := range slices.Sorted(maps.Keys(history)) {
			session := history[region]
			if bytes := DecodedBytes(session); bytes > SessionLimit {
				s.ports.Emit("warn", "workbench.tab.session.dropped", map[string]any{"tab": tab, "region": region, "bytes": bytes})
				continue
			}
			if regions == nil {
				regions = map[string]TabRegionSession{}
			}
			regions[region] = TabRegionSession{session}
		}
		s.put(tab, regions, answer)
	})
}

// reported is Capture for a write that no caller waits for, so its failure goes to the error display.
func (s *TabSessions) reported(tab string, answer func()) {
	s.Capture(tab, func(err error) {
		if err != nil {
			s.ports.Failed(fmt.Sprintf("tab session of %s: %s", tab, err))
		}
		answer()
	})
}

// Read answers with the stored interactionState of each region of tab, or nil for a tab without a file.
func (s *TabSessions) Read(tab string, answer func(sessions map[string]string, err error)) {
	s.ports.Store.TabSession(tab, func(document json.RawMessage, err error) {
		if err != nil || len(document) == 0 {
			answer(nil, err)
			return
		}
		var stored struct {
			Regions map[string]TabRegionSession `json:"regions"`
		}
		if err := json.Unmarshal(document, &stored); err != nil {
			answer(nil, fmt.Errorf("tab session of %s: %w", tab, err))
			return
		}
		sessions := make(map[string]string, len(stored.Regions))
		for name, region := range stored.Regions {
			sessions[name] = region.Session
		}
		answer(sessions, nil)
	})
}

// Navigated takes the history of a document state of the region name of tab. A changed index or address list is a navigation commit,
// and the session of the tab is written at most once per second. A changed title alone is no navigation.
func (s *TabSessions) Navigated(tab, name string, history TabHistory) {
	if s.removed[tab] {
		return
	}
	urls := make([]string, len(history.Entries))
	for index, entry := range history.Entries {
		urls[index] = entry.URL
	}
	encoded, err := json.Marshal([]any{history.Index, urls})
	if err != nil {
		s.ports.Failed(fmt.Sprintf("tab session of %s: %s", tab, err))
		return
	}
	regions := s.histories[tab]
	if regions == nil {
		regions = map[string]string{}
		s.histories[tab] = regions
	}
	key := string(encoded)
	if regions[name] == key {
		return
	}
	regions[name] = key
	if s.pending[tab] != nil {
		return
	}
	s.pending[tab] = s.ports.After(tabCoalesceMilliseconds, func() { s.reported(tab, func() {}) })
}

func (s *TabSessions) remove(tabs []string, answer func(err error)) {
	var first error
	left := len(tabs)
	if left == 0 {
		answer(nil)
		return
	}
	for _, tab := range tabs {
		s.pending.cancel(tab)
		delete(s.histories, tab)
		s.removed[tab] = true
		s.put(tab, nil, func(err error) {
			if first == nil {
				first = err
			}
			left--
			if left == 0 {
				answer(first)
			}
		})
	}
}

// Remove removes the files of tabs. The caller runs it after the layout write that drops them is confirmed, so a refused write removes
// none.
func (s *TabSessions) Remove(tabs []string, answer func(err error)) { s.remove(tabs, answer) }

// Reconcile removes each file that kept does not keep, with an event per file.
func (s *TabSessions) Reconcile(kept func(tab string) bool, answer func(err error)) {
	s.ports.Store.TabSessions(func(tabs []string, err error) {
		if err != nil {
			answer(err)
			return
		}
		orphans := slices.DeleteFunc(tabs, kept)
		for _, tab := range orphans {
			s.ports.Emit("info", "workbench.tab.session.orphan", map[string]any{"tab": tab})
		}
		s.remove(orphans, answer)
	})
}

// Flush writes the session of every tab with attached regions now. The window calls it at quit, before the regions close.
func (s *TabSessions) Flush(answer func()) {
	tabs := s.ports.Tabs()
	left := len(tabs)
	if left == 0 {
		answer()
		return
	}
	for _, tab := range tabs {
		s.reported(tab, func() {
			left--
			if left == 0 {
				answer()
			}
		})
	}
}
