// The tab state store tab-state.json and the tab sessions tab-sessions/<tab>.json of the memory saver
// (docs/spec/projects.md#persistence), as packages/workbench/test/tab-state.test.mjs and tab-session.test.mjs state them for the page
// workbench.
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sort"
	"strings"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// clock is a timer queue that only tick moves.
type clock struct {
	now    int64
	timers []*savedTimer
}

func (c *clock) after(milliseconds int64, run func()) func() {
	timer := &savedTimer{at: c.now + milliseconds, run: run}
	c.timers = append(c.timers, timer)
	return func() { timer.canceled = true }
}

func (c *clock) tick(milliseconds int64) {
	c.now += milliseconds
	for _, timer := range slices.Clone(c.timers) {
		if !timer.canceled && timer.at <= c.now {
			timer.canceled = true
			timer.run()
		}
	}
}

type stateEvents struct{ events []savedEvent }

func (e *stateEvents) emit(level, name string, fields map[string]any) {
	e.events = append(e.events, savedEvent{level, name, fields})
}

type statePut struct {
	tab   string
	entry *workbench.TabEntry
}

// stateStore is a store over one document. A held answer waits until release runs it.
type stateStore struct {
	document string
	puts     []statePut
	refuse   error
}

func (s *stateStore) TabState(answer func(json.RawMessage, error)) {
	if s.document == "" {
		answer(nil, nil)
		return
	}
	answer(json.RawMessage(s.document), nil)
}

func (s *stateStore) TabStatePut(tab string, entry *workbench.TabEntry, answer func(int, error)) {
	if s.refuse != nil {
		answer(0, s.refuse)
		return
	}
	s.puts = append(s.puts, statePut{tab, entry})
	answer(len(tab), nil)
}

func openStates(t *testing.T, store *stateStore) (*workbench.TabStates, *clock, *stateEvents, *[]string) {
	t.Helper()
	timers, events, failures := &clock{}, &stateEvents{}, &[]string{}
	var opened *workbench.TabStates
	workbench.OpenTabStates(workbench.TabStatePorts{
		Store:    store,
		Failed:   func(text string) { *failures = append(*failures, text) },
		UnloadOf: func(plugin string) bool { return plugin == "declaring" },
		Emit:     events.emit,
		After:    timers.after,
	}, func(states *workbench.TabStates, err error) {
		if err != nil {
			t.Fatal(err)
		}
		opened = states
	})
	if opened == nil {
		t.Fatal("the store did not open")
	}
	return opened, timers, events, failures
}

func state(value int) json.RawMessage {
	encoded, _ := json.Marshal(map[string]any{"format": 1, "value": value})
	return encoded
}

func labelOf(value string) *string { return &value }

func entryOf(states *workbench.TabStates, tab string) string {
	entry, found := states.Entry(tab)
	if !found {
		return "null"
	}
	encoded, _ := json.Marshal(entry)
	return string(encoded)
}

func TestAReaderAcceptsFormat1AndRefusesAnotherFormatWithTheFileAndTheFormatFound(t *testing.T) {
	for _, document := range []string{"", "null"} {
		tabs, err := workbench.CheckTabStateDocument(json.RawMessage(document))
		if err != nil || len(tabs) != 0 {
			t.Fatalf("%q: %v %v", document, tabs, err)
		}
	}
	tabs, err := workbench.CheckTabStateDocument(json.RawMessage(`{"format":1,"tabs":{"a":{"kept":true}}}`))
	if err != nil || !tabs["a"].Kept {
		t.Fatalf("%v %v", tabs, err)
	}
	for document, want := range map[string]string{
		`{"format":2,"tabs":{}}`:   "tab-state.json: tab state format 2 is not 1",
		`{"tabs":{}}`:              "tab-state.json: tab state format missing is not 1",
		`{"format":1,"tabs":[]}`:   "tab-state.json: tab state tabs is not an object",
		`{"format":1}`:             "tab-state.json: tab state tabs is not an object",
		`{"format":"1","tabs":{}}`: `tab-state.json: tab state format "1" is not 1`,
	} {
		_, err := workbench.CheckTabStateDocument(json.RawMessage(document))
		equal(t, message(err), want)
	}
	var refused error
	workbench.OpenTabStates(workbench.TabStatePorts{Store: &stateStore{document: `{"format":2,"tabs":{}}`}}, func(_ *workbench.TabStates, err error) { refused = err })
	equal(t, message(refused), "tab-state.json: tab state format 2 is not 1")
}

func TestWritesOfOneTabAreCoalescedToOnePerSecondAndEachStoreWriteIsAnEvent(t *testing.T) {
	store := &stateStore{}
	states, timers, events, _ := openStates(t, store)
	states.Write("tab-a", state(1))
	states.Write("tab-a", state(2))
	states.SetKept("tab-a", true)
	states.Write("tab-b", state(3))
	equal(t, len(store.puts), 0)
	equal(t, entryOf(states, "tab-a"), `{"state":{"format":1,"value":2},"kept":true}`)
	timers.tick(999)
	equal(t, len(store.puts), 0)
	timers.tick(1)
	equal(t, len(store.puts), 2)
	equal(t, store.puts[0].tab, "tab-a")
	equal(t, store.puts[1].tab, "tab-b")
	first, _ := json.Marshal(store.puts[0].entry)
	equal(t, string(first), `{"state":{"format":1,"value":2},"kept":true}`)
	equal(t, events.events, []savedEvent{
		{"debug", "workbench.tab.state.stored", map[string]any{"tab": "tab-a", "bytes": 5}},
		{"debug", "workbench.tab.state.stored", map[string]any{"tab": "tab-b", "bytes": 5}},
	})
	states.SetKept("tab-a", false)
	timers.tick(1000)
	last, _ := json.Marshal(store.puts[len(store.puts)-1].entry)
	equal(t, string(last), `{"state":{"format":1,"value":2}}`)
}

func TestQuitFlushesThePendingWritesAtOnce(t *testing.T) {
	store := &stateStore{}
	states, timers, _, _ := openStates(t, store)
	states.Write("tab-a", state(1))
	flushed := false
	states.Flush(func() { flushed = true })
	equal(t, flushed, true)
	equal(t, len(store.puts), 1)
	timers.tick(1000)
	equal(t, len(store.puts), 1)
}

func TestIdleWaitsForTheWritesStartedSoFar(t *testing.T) {
	var held []func()
	store := &heldStateStore{held: &held}
	timers, events := &clock{}, &stateEvents{}
	var states *workbench.TabStates
	workbench.OpenTabStates(workbench.TabStatePorts{Store: store, Failed: func(string) {}, UnloadOf: func(string) bool { return true }, Emit: events.emit, After: timers.after},
		func(opened *workbench.TabStates, err error) { states = opened })
	states.SetKept("a", true)
	done := false
	states.Flush(func() { done = true })
	equal(t, done, false)
	states.SetKept("b", true)
	states.Flush(func() {})
	held[0]()
	// The first flush does not wait for the write that began after it.
	equal(t, done, true)
}

type heldStateStore struct{ held *[]func() }

func (s *heldStateStore) TabState(answer func(json.RawMessage, error)) { answer(nil, nil) }
func (s *heldStateStore) TabStatePut(_ string, _ *workbench.TabEntry, answer func(int, error)) {
	*s.held = append(*s.held, func() { answer(1, nil) })
}

func TestAnEntryIsRemovedOnlyByTheRemovalAfterTheConfirmedLayoutWrite(t *testing.T) {
	store := &stateStore{document: `{"format":1,"tabs":{"a":{"kept":true},"b":{"kept":true}}}`}
	states, _, _, _ := openStates(t, store)
	removed := false
	states.Remove([]string{"a", "absent"}, func() { removed = true })
	equal(t, removed, true)
	equal(t, store.puts, []statePut{{"a", nil}})
	equal(t, entryOf(states, "a"), "null")
	equal(t, entryOf(states, "b"), `{"kept":true}`)
}

func TestARemovalCancelsThePendingWriteOfTheTab(t *testing.T) {
	store := &stateStore{}
	states, timers, _, _ := openStates(t, store)
	states.SetKept("a", true)
	states.Remove([]string{"a"}, func() {})
	timers.tick(1000)
	equal(t, store.puts, []statePut{{"a", nil}})
}

func TestLoadReconciliationRemovesEachOrphanEntryWithAnEvent(t *testing.T) {
	store := &stateStore{document: `{"format":1,"tabs":{"a":{"kept":true},"gone":{"label":"x"},"lost":{"kept":true},"spc-aaaaaa/left/files.tree":{"state":{"format":1,"value":{}}}}}`}
	states, _, events, _ := openStates(t, store)
	kept := shown("a", "b", "spc-aaaaaa/left/files.tree")
	states.Reconcile(func(tab string) bool { return kept[tab] }, func() {})
	equal(t, store.puts, []statePut{{"gone", nil}, {"lost", nil}})
	var orphans []savedEvent
	for _, event := range events.events {
		if event.name == "workbench.tab.state.orphan" {
			orphans = append(orphans, event)
		}
	}
	equal(t, orphans, []savedEvent{
		{"info", "workbench.tab.state.orphan", map[string]any{"tab": "gone"}},
		{"info", "workbench.tab.state.orphan", map[string]any{"tab": "lost"}},
	})
	equal(t, entryOf(states, "gone"), "null")
}

func TestTheLabelCacheKeepsTheLabelOfADeclaringPluginAndRemovesItOnNull(t *testing.T) {
	store := &stateStore{}
	states, _, _, _ := openStates(t, store)
	states.CacheLabel("tab-e", "declaring", labelOf("notes.md"))
	states.CacheLabel("tab-s", "undeclared", labelOf("zsh"))
	states.Flush(func() {})
	equal(t, len(store.puts), 1)
	equal(t, store.puts[0].tab, "tab-e")
	equal(t, *states.Label("tab-e"), "notes.md")
	equal(t, states.Label("tab-s") == nil, true)
	states.CacheLabel("tab-e", "declaring", nil)
	states.Flush(func() {})
	equal(t, store.puts[1], statePut{"tab-e", nil})
}

func TestAFailedStoreWriteIsReportedAndTheEntryStaysInMemory(t *testing.T) {
	store := &stateStore{refuse: errors.New("disk full")}
	states, _, _, failures := openStates(t, store)
	states.SetKept("tab-a", true)
	states.Flush(func() {})
	equal(t, *failures, []string{"tab state of tab-a: disk full"})
	equal(t, entryOf(states, "tab-a"), `{"kept":true}`)
}

// sessionStore is a store over the session files.
type sessionStore struct {
	files  map[string]map[string]workbench.TabRegionSession
	puts   []string
	refuse error
}

func (s *sessionStore) TabSession(tab string, answer func(json.RawMessage, error)) {
	regions, found := s.files[tab]
	if !found {
		answer(nil, nil)
		return
	}
	encoded, _ := json.Marshal(map[string]any{"format": 1, "regions": regions})
	answer(encoded, nil)
}

func (s *sessionStore) TabSessionPut(tab string, regions map[string]workbench.TabRegionSession, answer func(int, error)) {
	if s.refuse != nil {
		answer(0, s.refuse)
		return
	}
	s.puts = append(s.puts, tab)
	if regions == nil {
		delete(s.files, tab)
		answer(0, nil)
		return
	}
	s.files[tab] = regions
	encoded, _ := json.Marshal(map[string]any{"format": 1, "regions": regions})
	answer(len(encoded), nil)
}

func (s *sessionStore) TabSessions(answer func([]string, error)) {
	tabs := []string{}
	for tab := range s.files {
		tabs = append(tabs, tab)
	}
	sort.Strings(tabs)
	answer(tabs, nil)
}

type sessionHarness struct {
	sessions *workbench.TabSessions
	store    *sessionStore
	timers   *clock
	events   *stateEvents
	failures []string
	history  map[string]map[string]string
	attached []string
}

func newSessions() *sessionHarness {
	h := &sessionHarness{store: &sessionStore{files: map[string]map[string]workbench.TabRegionSession{}}, timers: &clock{}, events: &stateEvents{},
		history: map[string]map[string]string{}}
	h.sessions = workbench.NewTabSessions(workbench.TabSessionPorts{
		Store: h.store,
		Interaction: func(tab string, answer func(map[string]string, error)) {
			answer(h.history[tab], nil)
		},
		Tabs:   func() []string { return h.attached },
		Failed: func(text string) { h.failures = append(h.failures, text) },
		Emit:   h.events.emit,
		After:  h.timers.after,
	})
	return h
}

func (h *sessionHarness) capture(t *testing.T, tab string) error {
	t.Helper()
	var result error
	called := false
	h.sessions.Capture(tab, func(err error) { result, called = err, true })
	if !called {
		t.Fatal("the capture did not answer")
	}
	return result
}

func at(index int, urls ...string) workbench.TabHistory {
	history := workbench.TabHistory{Index: index}
	for _, url := range urls {
		history.Entries = append(history.Entries, workbench.TabHistoryEntry{URL: url, Title: url})
	}
	return history
}

func TestASessionIsCapturedAndReadBack(t *testing.T) {
	h := newSessions()
	h.history["tab-a"] = map[string]string{"page": "AAAA"}
	if err := h.capture(t, "tab-a"); err != nil {
		t.Fatal(err)
	}
	equal(t, h.store.files["tab-a"], map[string]workbench.TabRegionSession{"page": {Session: "AAAA"}})
	equal(t, h.events.events, []savedEvent{{"debug", "workbench.tab.session.stored", map[string]any{"tab": "tab-a", "bytes": 50}}})
	var read map[string]string
	h.sessions.Read("tab-a", func(regions map[string]string, err error) {
		if err != nil {
			t.Fatal(err)
		}
		read = regions
	})
	equal(t, read, map[string]string{"page": "AAAA"})
	h.sessions.Read("tab-b", func(regions map[string]string, _ error) { read = regions })
	equal(t, read == nil, true)
}

func TestNavigationCommitsOfATabAreCoalescedToOneWritePerSecondAndATitleChangeIsNoCommit(t *testing.T) {
	h := newSessions()
	h.attached = []string{"tab-a", "tab-b"}
	h.history["tab-a"] = map[string]string{"page": "S-a"}
	h.history["tab-b"] = map[string]string{"page": "S-b"}
	h.sessions.Navigated("tab-a", "page", at(0, "https://a.test/"))
	h.sessions.Navigated("tab-a", "page", at(1, "https://a.test/", "https://a.test/2"))
	h.sessions.Navigated("tab-b", "page", at(0, "https://b.test/"))
	h.timers.tick(999)
	equal(t, len(h.store.puts), 0)
	h.timers.tick(1)
	equal(t, h.store.puts, []string{"tab-a", "tab-b"})
	h.store.puts = nil
	h.sessions.Navigated("tab-a", "page", workbench.TabHistory{Index: 1, Entries: []workbench.TabHistoryEntry{{URL: "https://a.test/", Title: "A"}, {URL: "https://a.test/2", Title: "renamed"}}})
	h.timers.tick(1000)
	equal(t, len(h.store.puts), 0)
	flushed := false
	h.sessions.Flush(func() { flushed = true })
	equal(t, flushed, true)
	equal(t, h.store.puts, []string{"tab-a", "tab-b"})
}

func TestARegionSessionOver1MiBDecodedIsDroppedWithAWarnEventAndTheOthersAreStored(t *testing.T) {
	limit := workbench.SessionLimit
	large := strings.Repeat("A", (limit+2)/3*4)
	equal(t, workbench.DecodedBytes(large), limit+2)
	equal(t, workbench.DecodedBytes("QQ=="), 1)
	equal(t, workbench.DecodedBytes("QUI="), 2)
	h := newSessions()
	h.history["tab-a"] = map[string]string{"page": large, "side": "AAAA"}
	if err := h.capture(t, "tab-a"); err != nil {
		t.Fatal(err)
	}
	equal(t, h.store.files["tab-a"], map[string]workbench.TabRegionSession{"side": {Session: "AAAA"}})
	equal(t, h.events.events[0], savedEvent{"warn", "workbench.tab.session.dropped", map[string]any{"tab": "tab-a", "region": "page", "bytes": limit + 2}})
	// A tab whose every region is over the limit keeps no file.
	h.history["tab-a"] = map[string]string{"page": large}
	if err := h.capture(t, "tab-a"); err != nil {
		t.Fatal(err)
	}
	_, found := h.store.files["tab-a"]
	equal(t, found, false)
}

func TestATabWithoutRegionsWritesNothing(t *testing.T) {
	h := newSessions()
	if err := h.capture(t, "tab-a"); err != nil {
		t.Fatal(err)
	}
	equal(t, len(h.store.puts), 0)
}

func TestClosingATabRemovesItsFileAndTheReconcileRemovesTheFilesOfTabsInNoLayout(t *testing.T) {
	h := newSessions()
	for _, tab := range []string{"tab-a", "tab-b", "tab-c"} {
		h.history[tab] = map[string]string{"page": "AAAA"}
		if err := h.capture(t, tab); err != nil {
			t.Fatal(err)
		}
	}
	h.sessions.Remove([]string{"tab-a"}, func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	})
	_, found := h.store.files["tab-a"]
	equal(t, found, false)
	// A later state of the closing region writes nothing.
	h.sessions.Navigated("tab-a", "page", at(0, "https://a.test/"))
	h.timers.tick(1000)
	if err := h.capture(t, "tab-a"); err != nil {
		t.Fatal(err)
	}
	_, found = h.store.files["tab-a"]
	equal(t, found, false)
	h.events.events = nil
	h.sessions.Reconcile(func(tab string) bool { return tab == "tab-b" }, func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	})
	equal(t, len(h.store.files), 1)
	equal(t, h.events.events, []savedEvent{{"info", "workbench.tab.session.orphan", map[string]any{"tab": "tab-c"}}})
}

func TestAFailedCoalescedWriteIsShownThroughTheErrorDisplay(t *testing.T) {
	h := newSessions()
	h.store.refuse = errors.New("disk full")
	h.history["tab-a"] = map[string]string{"page": "AAAA"}
	h.sessions.Navigated("tab-a", "page", at(0, "https://a.test/"))
	h.timers.tick(1000)
	equal(t, h.failures, []string{"tab session of tab-a: disk full"})
}

func TestACaptureForTheUnloadAnswersWithItsFailure(t *testing.T) {
	h := newSessions()
	h.store.refuse = errors.New("disk full")
	h.history["tab-a"] = map[string]string{"page": "AAAA"}
	equal(t, message(h.capture(t, "tab-a")), "disk full")
	equal(t, len(h.failures), 0)
}

func TestTheHostStoreCallsTheWorkspaceKindsInOrder(t *testing.T) {
	var kinds []string
	puts := make(chan struct{}, 1)
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"workspace": func(_ context.Context, argument json.RawMessage) (any, error) {
			var request struct {
				Kind string `json:"kind"`
			}
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			kinds = append(kinds, string(argument))
			defer func() { puts <- struct{}{} }()
			switch request.Kind {
			case "tabState", "tabSession":
				return map[string]any{"format": 1, "tabs": map[string]any{}}, nil
			case "tabSessions":
				return []string{"a"}, nil
			}
			return 12, nil
		},
	}, func(task func()) { task() })
	store := workbench.HostTabStore{Calls: calls}
	wait := func() { <-puts }
	store.TabState(func(document json.RawMessage, err error) {
		if err != nil || string(document) != `{"format":1,"tabs":{}}` {
			t.Errorf("%s %v", document, err)
		}
	})
	wait()
	store.TabStatePut("a", nil, func(bytes int, err error) {
		if err != nil || bytes != 12 {
			t.Errorf("%d %v", bytes, err)
		}
	})
	wait()
	store.TabStatePut("a", &workbench.TabEntry{Kept: true}, func(int, error) {})
	wait()
	store.TabSession("a", func(json.RawMessage, error) {})
	wait()
	store.TabSessionPut("a", nil, func(int, error) {})
	wait()
	store.TabSessionPut("a", map[string]workbench.TabRegionSession{"page": {Session: "AAAA"}}, func(int, error) {})
	wait()
	store.TabSessions(func(tabs []string, err error) {
		if err != nil || !slices.Equal(tabs, []string{"a"}) {
			t.Errorf("%v %v", tabs, err)
		}
	})
	wait()
	equal(t, kinds, []string{
		`{"kind":"tabState"}`,
		`{"entry":null,"kind":"tabStatePut","tab":"a"}`,
		`{"entry":{"kept":true},"kind":"tabStatePut","tab":"a"}`,
		`{"kind":"tabSession","tab":"a"}`,
		`{"kind":"tabSessionPut","regions":null,"tab":"a"}`,
		`{"kind":"tabSessionPut","regions":{"page":{"session":"AAAA"}},"tab":"a"}`,
		`{"kind":"tabSessions"}`,
	})
}
