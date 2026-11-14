// The memory saver unloads a hidden tab after the delay or under memory pressure and restores it when it is shown again
// (docs/spec/plugins.md#memory-saver), as packages/workbench/test/memory-saver.test.mjs states it for the page workbench.
package workbench_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

const minute = int64(60_000)

type savedEvent struct {
	level, name string
	fields      map[string]any
}

type savedTimer struct {
	at       int64
	run      func()
	canceled bool
}

// saverHarness is the memory saver over ports that read the keeps, regions and settings that the test holds as data, with an instant that only tick moves.
type saverHarness struct {
	saver    *workbench.MemorySaver
	now      int64
	timers   []*savedTimer
	enabled  bool
	delay    int
	keeps    map[string][]string
	kept     map[string]bool
	commits  [][]string
	changes  int
	failures []string
	states   [][2]string
	events   []savedEvent
	labels   []string
	stored   []string
	restored []string
	asked    int
	regions  func(tab string, answer func([]string, error))
	interact func(tab string, answer func(error))
	commit   func(answer func(error))
}

func newSaver() *saverHarness {
	h := &saverHarness{now: 1_000_000, enabled: true, delay: 120, keeps: map[string][]string{}, kept: map[string]bool{}}
	h.saver = workbench.NewMemorySaver(workbench.MemorySaverPorts{
		Now:     func() int64 { return h.now },
		Enabled: func() bool { return h.enabled },
		Delay:   func() int { return h.delay },
		Declaration: func(surface workbench.MemorySurface) string {
			switch surface.Plugin {
			case "undeclared", "background":
				return surface.Plugin
			}
			return "unload"
		},
		Keeps:   func(tab string) []string { return h.keeps[tab] },
		Kept:    func(tab string) bool { return h.kept[tab] },
		SetKept: func(tab string, on bool) { h.kept[tab] = on },
		Regions: func(tab string, answer func([]string, error)) {
			h.asked++
			if h.regions != nil {
				h.regions(tab, answer)
				return
			}
			answer(nil, nil)
		},
		Interaction: func(tab string, answer func(error)) {
			h.stored = append(h.stored, tab)
			if h.interact != nil {
				h.interact(tab, answer)
				return
			}
			answer(nil)
		},
		Restore: func(tab string) { h.restored = append(h.restored, tab) },
		Commit: func(answer func(error)) {
			if h.commit != nil {
				h.commit(answer)
				return
			}
			h.commits = append(h.commits, h.saver.Place(nil).Unload)
			answer(nil)
		},
		ShowLabel:    func(tab string) { h.labels = append(h.labels, tab) },
		Changed:      func() { h.changes++ },
		Failed:       func(text string) { h.failures = append(h.failures, text) },
		StateChanged: func(tab, state string) { h.states = append(h.states, [2]string{tab, state}) },
		Emit: func(level, name string, fields map[string]any) {
			h.events = append(h.events, savedEvent{level, name, fields})
		},
		After: func(milliseconds int64, run func()) func() {
			timer := &savedTimer{at: h.now + milliseconds, run: run}
			h.timers = append(h.timers, timer)
			return func() { timer.canceled = true }
		},
	})
	return h
}

// tick moves the clock and runs the timers that are due, in the order of their time.
func (h *saverHarness) tick(milliseconds int64) {
	end := h.now + milliseconds
	for {
		var next *savedTimer
		for _, timer := range h.timers {
			if !timer.canceled && timer.at <= end && (next == nil || timer.at < next.at) {
				next = timer
			}
		}
		if next == nil {
			break
		}
		next.canceled = true
		h.now = max(h.now, next.at)
		next.run()
	}
	h.now = end
}

func (h *saverHarness) named(name string) []map[string]any {
	var fields []map[string]any
	for _, event := range h.events {
		if event.name == name {
			fields = append(fields, event.fields)
		}
	}
	return fields
}

func pluginOf(id string) string {
	switch {
	case strings.HasPrefix(id, "u-"):
		return "undeclared"
	case strings.HasPrefix(id, "g-"):
		return "background"
	}
	return "fixture"
}

func surfaces(ids ...string) []workbench.MemorySurface {
	var all []workbench.MemorySurface
	for _, id := range ids {
		all = append(all, workbench.MemorySurface{ID: id, Plugin: pluginOf(id), Kind: "tab"})
	}
	return all
}

func shown(ids ...string) map[string]bool {
	set := map[string]bool{}
	for _, id := range ids {
		set[id] = true
	}
	return set
}

func (h *saverHarness) observe(t *testing.T, visible []string, ids ...string) {
	t.Helper()
	if err := h.saver.Observe(shown(visible...), surfaces(ids...)); err != nil {
		t.Fatal(err)
	}
}

func (h *saverHarness) reasons(t *testing.T, tab string) []string {
	t.Helper()
	reasons, err := h.saver.Reasons(tab)
	if err != nil {
		t.Fatal(err)
	}
	return reasons
}

func equal(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestTheDelayUnloadsAHiddenTabAndAShowRestoresIt(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.observe(t, []string{"a", "b"}, "a", "b")
	h.observe(t, []string{"b"}, "a", "b")
	h.tick(120*minute - 1)
	equal(t, h.saver.Unloaded("a"), false)
	h.tick(1)
	equal(t, h.saver.Unloaded("a"), true)
	equal(t, h.commits, [][]string{{"a"}})
	equal(t, h.named("workbench.tab.unloaded"), []map[string]any{{"tab": "a", "plugin": "fixture", "trigger": "delay"}})
	h.observe(t, []string{"a"}, "a", "b")
	equal(t, h.saver.Unloaded("a"), false)
	equal(t, h.saver.State("a"), "restoring")
	if err := h.saver.Restored("a", false); err != nil {
		t.Fatal(err)
	}
	equal(t, h.saver.State("a"), "loaded")
	equal(t, h.named("workbench.tab.restored"), []map[string]any{{"tab": "a", "plugin": "fixture", "history": false}})
	equal(t, h.saver.Place([]string{"a", "b"}).Surfaces, []string{"a", "b"})
}

// protectedBy hides a tab from its first commit, lets two delays pass, and returns the reasons that keep it loaded.
func protectedBy(t *testing.T, tab string, setup func(h *saverHarness)) ([]string, *saverHarness) {
	t.Helper()
	h := newSaver()
	if setup != nil {
		setup(h)
	}
	h.saver.Classify()
	h.observe(t, []string{"x"}, "x", tab)
	h.tick(120 * minute)
	h.tick(120 * minute)
	equal(t, h.saver.Unloaded(tab), false)
	equal(t, len(h.named("workbench.tab.unloaded")), 0)
	return h.reasons(t, tab), h
}

func TestTheProtectionsKeepATabLoaded(t *testing.T) {
	regions := func(reasons ...string) func(*saverHarness) {
		return func(h *saverHarness) {
			h.regions = func(_ string, answer func([]string, error)) { answer(reasons, nil) }
		}
	}
	for _, c := range []struct {
		name, tab string
		setup     func(*saverHarness)
		want      []string
	}{
		{"keep:modified", "a", func(h *saverHarness) { h.keeps["a"] = []string{"keep:modified"} }, []string{"keep:modified"}},
		{"keep:busy", "a", func(h *saverHarness) { h.keeps["a"] = []string{"keep:busy"} }, []string{"keep:busy"}},
		{"kept", "a", func(h *saverHarness) { h.kept["a"] = true }, []string{"kept"}},
		{"off", "a", func(h *saverHarness) { h.enabled = false }, []string{"off"}},
		{"undeclared", "u-a", nil, []string{"undeclared"}},
		{"background", "g-a", nil, []string{"background"}},
		{"media", "a", regions("media"), []string{"media"}},
		{"capture and form", "a", regions("capture", "form"), []string{"capture", "form"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, _ := protectedBy(t, c.tab, c.setup)
			equal(t, got, c.want)
		})
	}
}

func TestShownProtectsTheShownTab(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.observe(t, []string{"a"}, "a")
	h.tick(240 * minute)
	equal(t, h.saver.Unloaded("a"), false)
	equal(t, h.reasons(t, "a"), []string{"shown"})
}

func TestRecentProtectsATabShownLessThanTheDelayAgo(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.observe(t, []string{"a"}, "a", "x")
	h.tick(10 * minute)
	h.observe(t, []string{"x"}, "a", "x")
	h.tick(100 * minute)
	equal(t, h.reasons(t, "a"), []string{"recent"})
}

func TestAMediaReplyMovesTheDeadlineOneDelayLater(t *testing.T) {
	_, h := protectedBy(t, "a", func(h *saverHarness) {
		h.regions = func(_ string, answer func([]string, error)) { answer([]string{"media"}, nil) }
	})
	// The first deadline at 120 minutes and the next one at 240 minutes each asked the regions once.
	equal(t, h.asked, 2)
}

func TestAnUnloadStoresTheSessionFirstAndARestoreGivesItBack(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.observe(t, []string{"b"}, "a", "b")
	h.tick(120 * minute)
	equal(t, h.saver.Unloaded("a"), true)
	equal(t, h.stored, []string{"a"})
	equal(t, len(h.restored), 0)
	h.observe(t, []string{"a"}, "a", "b")
	equal(t, h.restored, []string{"a"})
	if err := h.saver.Restored("a", true); err != nil {
		t.Fatal(err)
	}
	equal(t, h.named("workbench.tab.restored"), []map[string]any{{"tab": "a", "plugin": "fixture", "history": true}})
}

func TestTurningTheSettingOnKeepsTheHiddenTimeOfEachTab(t *testing.T) {
	h := newSaver()
	h.enabled = false
	h.saver.Classify()
	h.observe(t, []string{"x"}, "a", "x")
	h.tick(100 * minute)
	h.enabled = true
	h.saver.SettingsChanged()
	h.tick(20*minute - 1)
	equal(t, h.saver.Unloaded("a"), false)
	h.tick(1)
	equal(t, h.saver.Unloaded("a"), true)
}

func TestATabMountedWithoutBeingShownTakesItsMountTimeAsItsHiddenTime(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.observe(t, []string{"x"}, "x")
	h.tick(30 * minute)
	h.observe(t, []string{"x"}, "x", "a")
	h.tick(120*minute - 1)
	equal(t, h.saver.Unloaded("a"), false)
	h.tick(1)
	equal(t, h.saver.Unloaded("a"), true)
}

func pressure(t *testing.T, h *saverHarness, level string, seq int) {
	t.Helper()
	if err := h.saver.Pressure(level, seq); err != nil {
		t.Fatal(err)
	}
}

func TestOneCriticalReportUnloadsOneAtATimeLeastRecentlyShownFirstUntilANormalReport(t *testing.T) {
	h := newSaver()
	var gates []func(error)
	h.commit = func(answer func(error)) { gates = append(gates, answer) }
	h.saver.Classify()
	// a, b and c are shown in this order and then hidden; recent does not protect under pressure.
	all := []string{"a", "b", "c", "d"}
	for _, id := range []string{"c", "a", "b", "d"} {
		h.observe(t, []string{id}, all...)
		h.tick(minute)
	}
	pressure(t, h, "critical", 1)
	equal(t, len(gates), 1)
	gates[0](nil)
	equal(t, len(gates), 2)
	gates[1](nil)
	equal(t, len(gates), 3)
	pressure(t, h, "normal", 2)
	gates[2](nil)
	var order [][2]any
	for _, fields := range h.named("workbench.tab.unloaded") {
		order = append(order, [2]any{fields["tab"], fields["trigger"]})
	}
	equal(t, order, [][2]any{{"c", "pressure"}, {"a", "pressure"}, {"b", "pressure"}})
	equal(t, h.saver.Unloaded("d"), false)
	// A normal report stops the unloads of a later critical report after the unload in progress.
	h.observe(t, []string{"a"}, all...)
	h.observe(t, []string{"b"}, all...)
	pressure(t, h, "critical", 3)
	equal(t, len(gates), 4)
	pressure(t, h, "normal", 4)
	gates[3](nil)
	equal(t, len(gates), 4)
	equal(t, len(h.named("workbench.tab.unloaded")), 4)
}

func TestAPressureReportWithoutACandidateIsSkipped(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.keeps["a"] = []string{"keep:busy"}
	h.observe(t, []string{"x"}, "a", "x")
	pressure(t, h, "warn", 7)
	equal(t, h.named("workbench.tab.unload.skipped"), []map[string]any{{"trigger": "pressure", "seq": 7, "reasons": []string{"shown", "keep:busy"}}})
	equal(t, h.saver.Unloaded("a"), false)
}

func TestAPressureReportOfAnotherLevelIsRefused(t *testing.T) {
	h := newSaver()
	if err := h.saver.Pressure("high", 1); err == nil || err.Error() != `memory pressure report {"level":"high","seq":1} is not {level, seq}` {
		t.Fatalf("error %v", err)
	}
}

func TestAnInterruptionDuringAPendingStepLeavesTheTabLoaded(t *testing.T) {
	for _, c := range []struct {
		name      string
		interrupt func(t *testing.T, h *saverHarness)
		reasons   []string
	}{
		{"a show", func(t *testing.T, h *saverHarness) { h.observe(t, []string{"a"}, "a", "x") }, []string{"shown"}},
		{"a show and a hide", func(t *testing.T, h *saverHarness) {
			h.observe(t, []string{"a"}, "a", "x")
			h.observe(t, []string{"x"}, "a", "x")
		}, []string{"shown"}},
		{"a modified report", func(t *testing.T, h *saverHarness) {
			h.keeps["a"] = []string{"keep:modified"}
			h.saver.ProtectionsChanged()
		}, []string{"keep:modified"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newSaver()
			var release func(error)
			h.interact = func(_ string, answer func(error)) { release = answer }
			h.saver.Classify()
			h.observe(t, []string{"x"}, "a", "x")
			h.tick(120 * minute)
			if release == nil {
				t.Fatal("the attempt did not reach the interaction")
			}
			c.interrupt(t, h)
			release(nil)
			equal(t, h.saver.Unloaded("a"), false)
			equal(t, len(h.commits), 0)
			equal(t, h.named("workbench.tab.unload.skipped"), []map[string]any{{"trigger": "delay", "seq": 0, "reasons": c.reasons}})
		})
	}
}

func TestACommitAfterAnUnloadNeitherDeclaresTheTabNorReleasesItAsAClosedTab(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.observe(t, []string{"x"}, "a", "x")
	h.tick(120 * minute)
	equal(t, h.saver.Unloaded("a"), true)
	placed := h.saver.Place([]string{"x", "a"})
	// The tab stays in the layout: it is retained, so the commit does not release it as a closed tab, and it is not declared, so
	// the host keeps no surface for it.
	equal(t, placed.Surfaces, []string{"x"})
	equal(t, placed.Retain, map[string]bool{"x": true, "a": true})
	equal(t, placed.Unload, []string{"a"})
}

func TestARestartWithTheSettingOnStartsHiddenDeclaringTabsUnloadedWithTheirLabel(t *testing.T) {
	on := newSaver()
	on.observe(t, []string{"x"}, "x", "a", "u-b")
	on.saver.Classify()
	equal(t, on.saver.Unloaded("a"), true)
	equal(t, on.saver.Unloaded("u-b"), false)
	equal(t, on.saver.Unloaded("x"), false)
	equal(t, on.labels, []string{"a"})
	equal(t, len(on.named("workbench.tab.unloaded")), 0)
	off := newSaver()
	off.enabled = false
	off.observe(t, []string{"x"}, "x", "a")
	off.saver.Classify()
	equal(t, off.saver.Unloaded("a"), false)
}

func unload(t *testing.T, h *saverHarness, tab string) error {
	t.Helper()
	var result error
	called := false
	h.saver.Unload(tab, func(err error) { result, called = err, true })
	if !called {
		t.Fatal("the unload did not answer")
	}
	return result
}

func message(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func TestCoreTabUnloadUnloadsAHiddenTabThatRecentAndTheRegionsProtect(t *testing.T) {
	h := newSaver()
	h.regions = func(_ string, answer func([]string, error)) { answer([]string{"media", "capture", "form"}, nil) }
	h.saver.Classify()
	h.observe(t, []string{"a"}, "a", "x")
	h.observe(t, []string{"x"}, "a", "x")
	equal(t, h.reasons(t, "a"), []string{"recent"})
	h.changes = 0
	if err := unload(t, h, "a"); err != nil {
		t.Fatal(err)
	}
	equal(t, h.saver.Unloaded("a"), true)
	equal(t, h.commits, [][]string{{"a"}})
	equal(t, h.named("workbench.tab.unloaded"), []map[string]any{{"tab": "a", "plugin": "fixture", "trigger": "command"}})
	if h.changes == 0 {
		t.Fatal("the unload is not announced")
	}
	// An unloaded tab is unloaded again without another commit.
	if err := unload(t, h, "a"); err != nil {
		t.Fatal(err)
	}
	equal(t, len(h.commits), 1)
}

func TestCoreTabUnloadRefusesATabThatAStandingReasonProtects(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.observe(t, []string{"x"}, "x", "k", "u-a", "g-a")
	h.kept["k"] = true
	h.keeps["k"] = []string{"keep:modified"}
	for tab, want := range map[string]string{
		"x": "tab x is protected: shown", "k": "tab k is protected: keep:modified, kept", "u-a": "tab u-a is protected: undeclared",
		"g-a": "tab g-a is protected: background", "missing": "unknown tab missing",
	} {
		equal(t, message(unload(t, h, tab)), want)
	}
	equal(t, len(h.commits), 0)
}

func TestCoreTabUnloadFailsWithTheReasonsThatEndedTheAttempt(t *testing.T) {
	h := newSaver()
	h.regions = func(_ string, answer func([]string, error)) {
		h.observe(t, []string{"a"}, "a", "x")
		answer(nil, nil)
	}
	h.saver.Classify()
	h.observe(t, []string{"x"}, "a", "x")
	equal(t, message(unload(t, h, "a")), "tab a is protected: shown")
	equal(t, h.saver.Unloaded("a"), false)
}

func TestCoreTabKeepSetsAndClearsTheMarkOncePerChange(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.observe(t, []string{"x"}, "x", "a", "u-a", "g-a")
	for _, on := range []bool{true, true} {
		if err := h.saver.Keep("a", on); err != nil {
			t.Fatal(err)
		}
	}
	equal(t, h.reasons(t, "a"), []string{"kept"})
	if err := h.saver.Keep("a", false); err != nil {
		t.Fatal(err)
	}
	equal(t, h.kept["a"], false)
	equal(t, h.named("workbench.tab.keep.changed"), []map[string]any{{"tab": "a", "keep": true}, {"tab": "a", "keep": false}})
	equal(t, message(h.saver.Keep("u-a", true)), "tab u-a can never be unloaded: undeclared")
	equal(t, message(h.saver.Keep("g-a", false)), "tab g-a can never be unloaded: background")
	equal(t, message(h.saver.Keep("missing", true)), "unknown tab missing")
}

func TestTheStatusListsEachTabWithItsStateReasonsAndTimes(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.observe(t, []string{"x"}, "x", "a")
	hidden := h.now
	pressure(t, h, "normal", 3)
	read := func() string {
		encoded, err := json.Marshal(h.saver.Status())
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	equal(t, read(), fmt.Sprintf(`{"pressure":{"level":"normal","seq":3},"tabs":[`+
		`{"tab":"x","plugin":"fixture","kind":"tab","state":"loaded","reasons":["shown"],"hiddenAt":null,"unloadAt":null,"checkedAt":null},`+
		`{"tab":"a","plugin":"fixture","kind":"tab","state":"loaded","reasons":[],"hiddenAt":%d,"unloadAt":%d,"checkedAt":null}]}`,
		hidden, hidden+120*minute))
	h.tick(120 * minute)
	if !strings.Contains(read(), fmt.Sprintf(`{"tab":"a","plugin":"fixture","kind":"tab","state":"unloaded","reasons":[],"hiddenAt":%d,"unloadAt":null,"checkedAt":%d}`, hidden, hidden+120*minute)) {
		t.Fatal(read())
	}
}

func TestARefusedInteractionReadEndsTheAttemptWithAReportedFailure(t *testing.T) {
	h := newSaver()
	h.interact = func(_ string, answer func(error)) { answer(errors.New("document region page is gone")) }
	h.saver.Classify()
	h.observe(t, []string{"b"}, "a", "b")
	h.tick(120 * minute)
	equal(t, h.saver.Unloaded("a"), false)
	equal(t, len(h.commits), 0)
	equal(t, h.named("workbench.tab.unload.failed"), []map[string]any{{"tab": "a", "plugin": "fixture", "trigger": "delay", "reason": "document region page is gone"}})
	equal(t, h.failures, []string{"memory saver: tab a: unload failed: document region page is gone"})
	equal(t, len(h.states), 0)
	// A read that keeps failing runs once per delay, not again at the deadline that passed.
	h.tick(120*minute - 1)
	equal(t, len(h.failures), 1)
	h.tick(1)
	equal(t, len(h.failures), 2)
}

func TestAShownUnloadedTabIsRestoringUntilItsSurfaceMountsAndAFailedRestoreIsReported(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.observe(t, []string{"b"}, "a", "b")
	h.tick(120 * minute)
	h.observe(t, []string{"a"}, "a", "b")
	equal(t, h.states, [][2]string{{"a", "unloaded"}, {"a", "restoring"}})
	if err := h.saver.RestoreFailed("a", "stored format 2 is not the declared format 1"); err != nil {
		t.Fatal(err)
	}
	equal(t, h.saver.Unloaded("a"), false)
	equal(t, h.states[len(h.states)-1], [2]string{"a", "loaded"})
	equal(t, h.named("workbench.tab.restore.failed"), []map[string]any{{"tab": "a", "plugin": "fixture", "reason": "stored format 2 is not the declared format 1"}})
	equal(t, h.failures, []string{"memory saver: tab a: restore failed: stored format 2 is not the declared format 1"})
}

func TestAFailedCommitAfterTheTabIsMarkedReturnsItToLoaded(t *testing.T) {
	h := newSaver()
	fail := true
	h.commit = func(answer func(error)) {
		h.commits = append(h.commits, h.saver.Place(nil).Unload)
		if fail {
			fail = false
			answer(errors.New("host.place refused the layout"))
			return
		}
		answer(nil)
	}
	h.saver.Classify()
	h.observe(t, []string{"b"}, "a", "b")
	h.tick(120 * minute)
	equal(t, h.saver.Unloaded("a"), false)
	equal(t, h.saver.State("a"), "loaded")
	// The commit after the failure declares the surface of the tab again.
	equal(t, h.commits, [][]string{{"a"}, {}})
	equal(t, len(h.named("workbench.tab.unloaded")), 0)
	equal(t, h.named("workbench.tab.unload.failed"), []map[string]any{{"tab": "a", "plugin": "fixture", "trigger": "delay", "reason": "host.place refused the layout"}})
	equal(t, h.failures, []string{"memory saver: tab a: unload failed: host.place refused the layout"})
	equal(t, h.states, [][2]string{{"a", "unloaded"}, {"a", "loaded"}})
	h.tick(120 * minute)
	equal(t, h.saver.Unloaded("a"), true)
}

func TestAFailedCommitOfTheStartIsShown(t *testing.T) {
	h := newSaver()
	h.commit = func(answer func(error)) { answer(errors.New("host.place refused the layout")) }
	h.observe(t, []string{"x"}, "x", "a")
	h.saver.Classify()
	equal(t, h.failures, []string{"memory saver commit: host.place refused the layout"})
}

func TestTheDeclarationOfASurface(t *testing.T) {
	equal(t, workbench.UnloadDeclaration(workbench.MemorySurface{Kind: "tab", Unload: true}, true), "background")
	equal(t, workbench.UnloadDeclaration(workbench.MemorySurface{Kind: "section", Unload: true}, true), "unload")
	equal(t, workbench.UnloadDeclaration(workbench.MemorySurface{Kind: "tab", Unload: true}, false), "unload")
	equal(t, workbench.UnloadDeclaration(workbench.MemorySurface{Kind: "tab"}, false), "undeclared")
}

func TestASessionHistoryRefusedBeforeAnyCommitIsReported(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.saver.HistoryRefused("a", "fixture", "document region page: the web view refused the interactionState")
	equal(t, h.saver.State("a"), "")
	equal(t, h.named("workbench.tab.restore.failed"), []map[string]any{{"tab": "a", "plugin": "fixture", "reason": "document region page: the web view refused the interactionState"}})
	equal(t, h.failures, []string{"memory saver: tab a: restore failed: document region page: the web view refused the interactionState"})
}

func TestARefusedSessionHistoryKeepsTheRestoreOpen(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	h.observe(t, []string{"b"}, "a", "b")
	h.tick(120 * minute)
	h.observe(t, []string{"a"}, "a", "b")
	// The region refuses its history during the mount and attaches again without it.
	h.saver.HistoryRefused("a", "fixture", "document region page: interactionState is not a session history")
	equal(t, h.saver.State("a"), "restoring")
	if err := h.saver.Restored("a", false); err != nil {
		t.Fatal(err)
	}
	equal(t, h.saver.State("a"), "loaded")
	equal(t, h.named("workbench.tab.restored"), []map[string]any{{"tab": "a", "plugin": "fixture", "history": false}})
	// A refusal after the mount ended reports the failure and leaves the tab loaded.
	h.saver.HistoryRefused("a", "fixture", "document region page: refused")
	equal(t, h.saver.State("a"), "loaded")
	equal(t, len(h.named("workbench.tab.restore.failed")), 2)
}

func sectioned() []workbench.MemorySurface {
	return []workbench.MemorySurface{{ID: "a", Plugin: "p", Kind: "tab"}, {ID: "spc-aaaaaa/left/probe.tree", Plugin: "probe", Kind: "section"}}
}

func TestASectionSurfaceIsObservedWithTheTabsAndListedWithKindSection(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	if err := h.saver.Observe(shown("a"), sectioned()); err != nil {
		t.Fatal(err)
	}
	var kinds [][3]string
	for _, tab := range h.saver.Status().Tabs {
		kinds = append(kinds, [3]string{tab.Tab, tab.Kind, tab.State})
	}
	equal(t, kinds, [][3]string{{"a", "tab", "loaded"}, {"spc-aaaaaa/left/probe.tree", "section", "loaded"}})
	if err := h.saver.Observe(shown(), []workbench.MemorySurface{{ID: "a", Kind: "card"}}); err == nil || err.Error() != "memory saver: surface a has kind card" {
		t.Fatalf("error %v", err)
	}
}

func TestTheTabCommandsRefuseASectionSurfaceID(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	if err := h.saver.Observe(shown(), sectioned()); err != nil {
		t.Fatal(err)
	}
	if err := h.saver.Tab("a"); err != nil {
		t.Fatal(err)
	}
	equal(t, message(h.saver.Tab("spc-aaaaaa/left/probe.tree")), "spc-aaaaaa/left/probe.tree is a section surface, not a tab")
	equal(t, message(h.saver.Tab("missing")), `unknown tab "missing"`)
}

func memoryRegistry(t *testing.T, h *saverHarness) *workbench.Registry {
	t.Helper()
	r := registry(t)
	workbench.RegisterMemorySaver(r, h.saver, func() bool { return h.enabled }, func() int { return h.delay })
	return r
}

func TestTheMemoryCommandsAnswerWithTheCodesOfTheExposure(t *testing.T) {
	h := newSaver()
	h.saver.Classify()
	r := memoryRegistry(t, h)
	h.observe(t, []string{"x"}, "x", "a")
	var failure error
	answer := func(_ any, err error) { failure = err }
	invalid := func(want string) {
		t.Helper()
		var coded *workbench.Refusal
		if !errors.As(failure, &coded) || coded.Code != workbench.InvalidParams || coded.Message != want {
			t.Fatalf("error %#v, want -32602 %s", failure, want)
		}
	}
	r.RunLater("core.tab.unload", json.RawMessage(`{"tab":"missing"}`), answer)
	invalid(`unknown tab "missing"`)
	r.RunLater("core.tab.unload", json.RawMessage(`{"tab":7}`), answer)
	invalid("unknown tab 7")
	r.RunLater("core.tab.unload", nil, answer)
	invalid("unknown tab undefined")
	r.RunLater("core.tab.keep", json.RawMessage(`{"tab":"a","keep":"yes"}`), answer)
	invalid("keep must be a boolean")
	r.RunLater("core.tab.keep", json.RawMessage(`{"tab":"a"}`), answer)
	invalid("keep must be a boolean")
	r.RunLater("core.tab.keep", json.RawMessage(`{"tab":"a","keep":true}`), answer)
	equal(t, failure, nil)
	equal(t, h.kept["a"], true)
	r.RunLater("core.tab.keep", json.RawMessage(`{"tab":"a","keep":false}`), answer)
	r.RunLater("core.tab.unload", json.RawMessage(`{"tab":"x"}`), answer)
	equal(t, message(failure), "tab x is protected: shown")
	r.RunLater("core.tab.unload", json.RawMessage(`{"tab":"a"}`), answer)
	equal(t, failure, nil)
	equal(t, h.saver.Unloaded("a"), true)
	status, err := r.Read("core.tab.memory")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(encoded), `{"enabled":true,"delay":120,"pressure":{"level":"normal","seq":0},"tabs":[`) {
		t.Fatal(string(encoded))
	}
	commands, _ := r.Names()
	if !slices.Contains(commands, "core.tab.unload") || !slices.Contains(commands, "core.tab.keep") {
		t.Fatalf("commands %v", commands)
	}
}

// Only a surface first seen since the last classification starts unloaded, so a surface that the setting kept loaded waits for the delay.
func TestClassifyTakesOnlyASurfaceFirstSeenSinceTheLast(t *testing.T) {
	h := newSaver()
	h.enabled = false
	h.observe(t, []string{"x"}, "x", "a")
	h.saver.Classify()
	equal(t, h.saver.Unloaded("a"), false)
	h.enabled = true
	h.saver.Classify()
	equal(t, h.saver.Unloaded("a"), false)
	h.observe(t, []string{"x"}, "x", "a", "b")
	h.saver.Classify()
	equal(t, h.saver.Unloaded("a"), false)
	equal(t, h.saver.Unloaded("b"), true)
}
