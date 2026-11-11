package workbench_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// keyboardRing returns the card of the focus ring and the active surface of that card.
func keyboardRing(t *testing.T, f *shellFixture) (string, *string) {
	t.Helper()
	for _, card := range status[gridRead](t, f, "core.grid").Cards {
		if card.Focused {
			return card.ID, card.Active
		}
	}
	return "", nil
}

// keyboardCards returns the two cards of the shell and the first tab of each.
func keyboardCards(t *testing.T, f *shellFixture) (cards []string, tabs map[string][]string) {
	t.Helper()
	tabs = map[string][]string{}
	for _, card := range f.cardsOf() {
		data, _ := card["data"].(map[string]any) // silent: a window sidebar has no data.
		if data == nil || data["tabs"] == nil {
			continue
		}
		id := card["id"].(string)
		cards = append(cards, id)
		for _, tab := range data["tabs"].([]any) {
			tabs[id] = append(tabs[id], tab.(map[string]any)["id"].(string))
		}
	}
	return cards, tabs
}

// keyboardAddTab adds a tab of the terminal to card and returns the tabs of each card.
func keyboardAddTab(t *testing.T, f *shellFixture, card string) map[string][]string {
	t.Helper()
	f.run("core.card.focus", map[string]string{"card": card})
	f.click("core.card.add", card)
	f.click("core.picker.item", "textprobe")
	_, tabs := keyboardCards(t, f)
	return tabs
}

// The active surface of the card with the focus ring holds the keyboard after every path that moves the focus
// (docs/spec/exposure.md#keyboard-focus).
func TestTheKeyboardFollowsTheFocusRing(t *testing.T) {
	paths := []struct {
		name string
		// run takes the path after the test took the keyboard to the other card.
		run func(t *testing.T, f *shellFixture, stored *surfaceHost, other string)
	}{
		{"opening a project", func(*testing.T, *shellFixture, *surfaceHost, string) {}},
		{"a new tab", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			f.click("core.card.add", other)
			f.click("core.picker.item", "textprobe")
		}},
		{"a new tab of another card", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			f.click("core.card.add", other)
			f.click("core.picker.item", "boxprobe")
		}},
		{"a split", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			f.click("core.card.split-x", other)
			f.click("core.picker.item", "textprobe")
		}},
		{"a press on a tab", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			tabs := keyboardAddTab(t, f, other)
			f.click("core.card.tab", tabs[other][0])
		}},
		{"core.tab.select", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			tabs := keyboardAddTab(t, f, other)
			f.run("core.tab.select", map[string]string{"tab": tabs[other][0]})
		}},
		{"core.card.focus", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			f.run("core.card.focus", map[string]string{"card": other})
		}},
		{"a press on a card", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			f.click("core.card.header", other)
		}},
		{"a press on a surface", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			_, tabs := keyboardCards(t, f)
			f.shell.Event("surface-pressed", []any{tabs[other][0]})
			f.settle()
		}},
		{"closing the active tab", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			tabs := keyboardAddTab(t, f, other)
			f.run("core.tab.close", map[string]string{"tab": tabs[other][1]})
		}},
		{"closing a card", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			f.run("core.card.focus", map[string]string{"card": other})
			f.run("core.card.close", map[string]string{"card": other})
		}},
		{"restoring a space", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			f.run("core.card.focus", map[string]string{"card": other})
			first := f.host.projects[0]["activeSpaceId"].(string)
			f.click("core.space-tab.add", "")
			f.click("core.space-tab", first)
		}},
		{"closing a picker", func(t *testing.T, f *shellFixture, _ *surfaceHost, other string) {
			f.click("core.card.add", other)
			f.run("core.picker.close", nil)
		}},
		{"closing the settings", func(t *testing.T, f *shellFixture, _ *surfaceHost, _ string) {
			f.run("core.settings.open", nil)
			f.run("core.settings.close", nil)
		}},
		{"leaving the library", func(t *testing.T, f *shellFixture, _ *surfaceHost, _ string) {
			f.run("core.projects.browse", nil)
			f.run("core.library.return", nil)
		}},
		{"AppKit moving the keyboard to the workbench", func(t *testing.T, f *shellFixture, stored *surfaceHost, _ string) {
			stored.keyboard = nil
			f.shell.Event("window-responder", []any{map[string]any{"owner": "workbench", "surface": nil, "document": nil}})
			f.settle()
		}},
	}
	for _, path := range paths {
		t.Run(path.name, func(t *testing.T) {
			f, stored := surfaceShell(t)
			cards, _ := keyboardCards(t, f)
			focused, _ := keyboardRing(t, f)
			other := cards[0]
			if other == focused {
				other = cards[1]
			}
			path.run(t, f, stored, other)
			f.settle()
			ring, active := keyboardRing(t, f)
			if active == nil {
				t.Fatalf("the card %s of the ring has no active surface", ring)
			}
			got, ok := stored.keyboardTarget()
			if !ok {
				t.Fatalf("the ring is on the card %s and no keyboard call reached the host", ring)
			}
			if got == nil || *got != *active {
				t.Fatalf("the ring is on the surface %s and the keyboard went to %s", *active, describeTarget(got))
			}
		})
	}
}

func describeTarget(target *string) string {
	if target == nil {
		return "the workbench"
	}
	return *target
}

// A surface that is placed later receives the keyboard after the placement that holds it: the host call follows presentSurfaces.
func TestTheKeyboardCallFollowsThePlacementOfTheSurface(t *testing.T) {
	f, stored := surfaceShell(t)
	cards, _ := keyboardCards(t, f)
	stored.order = nil
	keyboardAddTab(t, f, cards[0])
	f.settle()
	last := strings.Join(stored.order, " ")
	if !strings.Contains(last, "syncSurfaces presentSurfaces surfaceFocus") {
		t.Fatalf("the calls of the new tab are %s", last)
	}
}

// A press on a tab whose surface the host already holds gives it the keyboard without waiting for a placement, also while one
// runs, so the host gives the keyboard at the release of the press, before a key that follows the release
// (docs/spec/native-surfaces.md#keyboard-of-a-surface).
func TestAPressOnAHeldTabSendsTheKeyboardBeforeItsPlacement(t *testing.T) {
	f, stored := surfaceShell(t)
	cards, _ := keyboardCards(t, f)
	keyboardAddTab(t, f, cards[0])
	f.settle()
	tabs := keyboardAddTab(t, f, cards[0])
	f.settle()
	held := tabs[cards[0]][len(tabs[cards[0]])-2]
	gate := gatedPlacement(t, f, stored)
	node, ok := exposedNode(f.tester.ElementTree(), "core.card.tab", held)
	if !ok {
		gate.open()
		t.Fatalf("the workbench shows no tab %s", held)
	}
	f.tester.ClickAt(node.Bounds.X+node.Bounds.W/2, node.Bounds.Y+node.Bounds.H/2)
	f.pending.drain(t)
	keyboard, _ := stored.keyboardCalls()
	gate.open()
	f.settle()
	if len(keyboard) == 0 || keyboard[len(keyboard)-1] == nil || *keyboard[len(keyboard)-1] != held {
		t.Fatalf("while a placement ran the press on %s sent the keyboard calls %v", held, describeTargets(keyboard))
	}
	got, ok := stored.keyboardTarget()
	if !ok || got == nil || *got != held {
		t.Fatalf("the press on %s gave the keyboard to %s (%v)", held, describeTarget(got), ok)
	}
}

// The keys of the window wait from the release of a press on the workbench for a decided call, so every press of the workbench, on
// any element, is answered by one decided call (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring).
func TestEveryPressOfTheWorkbenchEndsWithOneDecidedCall(t *testing.T) {
	presses := []struct{ name, item string }{
		{"core.card.tab", ""}, {"core.card.header", ""}, {"core.card", ""}, {"core.divider", ""}, {"core.chrome.bar", ""},
		{"core.chrome.left", ""}, {"core.sidebar.fold", ""}, {"core.card.add", ""}, {"core.chrome.settings", ""},
	}
	for _, press := range presses {
		t.Run(press.name, func(t *testing.T) {
			f, stored := surfaceShell(t)
			cards, _ := keyboardCards(t, f)
			keyboardAddTab(t, f, cards[0])
			f.settle()
			if !f.has(press.name, press.item) {
				t.Fatalf("the workbench shows no %s", press.name)
			}
			stored.keyboard, stored.decided = nil, nil
			f.click(press.name, press.item)
			f.settle()
			f.settle()
			decided := 0
			for _, one := range stored.decided {
				if one {
					decided++
				}
			}
			if decided != 1 {
				t.Fatalf("the press on %s sent %d decided calls of %d calls", press.name, decided, len(stored.decided))
			}
		})
	}
}

// While a modal is open the workbench holds the keyboard for it, and the host call does not name a surface.
func TestAModalKeepsTheKeyboardUntilItCloses(t *testing.T) {
	f, stored := surfaceShell(t)
	cards, _ := keyboardCards(t, f)
	f.click("core.card.add", cards[0])
	f.settle()
	if got, ok := stored.keyboardTarget(); !ok || got != nil {
		t.Fatalf("the picker is open and the keyboard went to %s (%v)", describeTarget(got), ok)
	}
	f.run("core.picker.close", nil)
	f.settle()
	if got, ok := stored.keyboardTarget(); !ok || got == nil {
		t.Fatalf("the picker closed and the keyboard stayed with %s (%v)", describeTarget(got), ok)
	}
}

// A window that shows the library has no surface in front, so the keyboard stays with the workbench for its form.
func TestTheLibraryKeepsTheKeyboardWithTheWorkbench(t *testing.T) {
	f, stored := surfaceShell(t)
	f.run("core.projects.browse", nil)
	f.settle()
	if got, ok := stored.keyboardTarget(); !ok || got != nil {
		t.Fatalf("the library shows and the keyboard went to %s (%v)", describeTarget(got), ok)
	}
}

// A rename field of the workbench holds the keyboard while it is open: its text and its shortcuts reach the workbench. When it closes
// the keyboard returns to the surface of the ring.
func TestARenameFieldHoldsTheKeyboardUntilItCloses(t *testing.T) {
	for _, end := range []string{"core.rename.commit", "core.rename.cancel"} {
		t.Run(end, func(t *testing.T) {
			f, stored := surfaceShell(t)
			f.settle()
			space := f.host.projects[0]["spaces"].([]any)[0].(map[string]any)["id"].(string)
			f.run("core.rename.begin", map[string]string{"kind": "space", "id": space})
			f.settle()
			if got, ok := stored.keyboardTarget(); !ok || got != nil {
				t.Fatalf("the rename field is open and the keyboard went to %s (%v)", describeTarget(got), ok)
			}
			f.run(end, nil)
			f.settle()
			_, want := keyboardRing(t, f)
			if got, ok := stored.keyboardTarget(); !ok || got == nil || want == nil || *got != *want {
				t.Fatalf("the field closed, the ring is on %s and the keyboard went to %s (%v)", describeTarget(want), describeTarget(got), ok)
			}
		})
	}
}

// A press on the active tab of the focused card moves the first responder to the workbench, and the call gives it back.
func TestAPressOnTheActiveTabGivesTheKeyboardBack(t *testing.T) {
	f, stored := surfaceShell(t)
	ring, active := keyboardRing(t, f)
	stored.keyboard = nil
	f.click("core.card.tab", *active)
	f.settle()
	got, ok := stored.keyboardTarget()
	if !ok || got == nil || *got != *active {
		t.Fatalf("the ring is on %s %s and the keyboard went to %s (%v)", ring, *active, describeTarget(got), ok)
	}
}

// A tab keeps the focus of the Tab key and takes none from a pointer press.
func TestAPressOnATabLeavesTheElementFocus(t *testing.T) {
	f, _ := surfaceShell(t)
	_, active := keyboardRing(t, f)
	f.click("core.card.tab", *active)
	if f.tester.Focused(tabFocusLabel(t, f, *active)) {
		t.Fatal("a press left the element focus on the tab")
	}
}

func tabFocusLabel(t *testing.T, f *shellFixture, tab string) string {
	t.Helper()
	return element(t, f.tester, "core.card.tab", tab).Label
}

// Every move of the focus ring goes through the one function, so a new path cannot skip the keyboard.
func TestTheFocusRingMovesInOnePlace(t *testing.T) {
	sources, err := filepath.Glob("../src/*.go")
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) == 0 {
		t.Fatal("no source of the workbench")
	}
	assignment := regexp.MustCompile(`\.focused(\s*,\s*[\w.]+)*\s*(:?=)[^=]`)
	for _, source := range sources {
		text, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		for number, line := range strings.Split(string(text), "\n") {
			if !assignment.MatchString(line) {
				continue
			}
			if filepath.Base(source) == "keyboard.go" && strings.TrimSpace(line) == "s.focused = card" {
				continue
			}
			t.Errorf("%s:%d assigns the focus ring directly: %s", filepath.Base(source), number+1, strings.TrimSpace(line))
		}
	}
}

// A modal that opens without a press takes the keyboard from the view, and the view of the focus ring takes it back when the modal
// closes: the question about a modified tab, the settings window and the debug view, each opened by its command.
func TestAModalThatACommandOpensTakesTheKeyboardFromTheView(t *testing.T) {
	for _, modal := range []struct{ name, open, end string }{
		{"question", "", "core.picker.close"},
		{"settings", "core.settings.open", "core.settings.close"},
		{"debug", "core.debug.open", "core.debug.close"},
	} {
		t.Run(modal.name, func(t *testing.T) {
			f, stored := surfaceShell(t)
			f.settle()
			before, ok := stored.keyboardTarget()
			if !ok || before == nil {
				t.Fatalf("the view does not hold the keyboard before the modal: %s (%v)", describeTarget(before), ok)
			}
			if modal.open == "" {
				viewCall(t, f, stored, *before, "tab.modified", true)
				f.run("core.tab.close", map[string]string{"tab": *before})
			} else {
				f.run(modal.open, nil)
			}
			f.settle()
			if got, ok := stored.keyboardTarget(); !ok || got != nil {
				t.Fatalf("the modal is open and the keyboard went to %s (%v)", describeTarget(got), ok)
			}
			f.run(modal.end, nil)
			f.settle()
			if got, ok := stored.keyboardTarget(); !ok || got == nil || *got != *before {
				t.Fatalf("the modal closed and the keyboard went to %s (%v), want %s", describeTarget(got), ok, *before)
			}
		})
	}
}

// keyboardAnswer runs the command name as the endpoint runs it and returns the calls that the host had and the target of its
// last keyboard call when the command answered.
func keyboardAnswer(t *testing.T, f *shellFixture, stored *surfaceHost, name string, params any) (answer any, calls string, target *string) {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	stored.orderMu.Lock()
	stored.order = nil
	stored.orderMu.Unlock()
	answered := false
	f.shell.Registry().RunLater(name, raw, func(value any, err error) {
		if err != nil {
			t.Errorf("%s failed: %v", name, err)
		}
		answered, answer = true, value
		calls, target = stored.calledNow()
	})
	f.settle()
	f.settle()
	if !answered {
		t.Fatalf("%s did not answer", name)
	}
	return answer, calls, target
}

// A command that moves the ring answers after the placement of the new tab and after the host answered the keyboard call to
// it, so a key that the caller sends after the answer reaches the new surface (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring).
func TestAnAddedTabHoldsTheKeyboardBeforeTheCommandAnswers(t *testing.T) {
	f, stored := surfaceShell(t)
	cards, _ := keyboardCards(t, f)
	f.run("core.card.focus", map[string]string{"card": cards[0]})
	f.settle()
	answer, calls, target := keyboardAnswer(t, f, stored, "core.card.add-tab", map[string]string{"card": cards[0], "plugin": "textprobe"})
	tab := answer.(map[string]string)["tab"]
	if !strings.HasSuffix(calls, "syncSurfaces presentSurfaces surfaceFocus") || target == nil || *target != tab {
		t.Fatalf("core.card.add-tab answered %s when the host had the calls %q and the keyboard in %s", tab, calls, describeTarget(target))
	}
}

// A command that moves the ring to a surface that the host holds answers after the host answered the keyboard call to it.
func TestACommandThatMovesTheRingAnswersAfterTheKeyboardCall(t *testing.T) {
	f, stored := surfaceShell(t)
	cards, tabs := keyboardCards(t, f)
	focused, _ := keyboardRing(t, f)
	other := cards[0]
	if other == focused {
		other = cards[1]
	}
	_, calls, target := keyboardAnswer(t, f, stored, "core.card.focus", map[string]string{"card": other})
	if target == nil || *target != tabs[other][0] {
		t.Fatalf("core.card.focus answered when the host had the calls %q and the keyboard in %s, not in %s", calls, describeTarget(target), tabs[other][0])
	}
}

// A tab that a frame draws while a placement without it runs takes the keyboard only after the placement that holds it: the end
// of the earlier placement gives the keyboard to the workbench, because the host does not hold the surface of the tab yet
// (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring).
func TestATabDrawnDuringAPlacementTakesTheKeyboardAfterItsOwnPlacement(t *testing.T) {
	f, stored := surfaceShell(t)
	cards, _ := keyboardCards(t, f)
	f.run("core.card.focus", map[string]string{"card": cards[0]})
	gate := newGate()
	stored.orderMu.Lock()
	stored.presentGate = gate
	stored.orderMu.Unlock()
	// A new size moves the surfaces, so a placement without the new tab starts and waits in presentSurfaces.
	f.tester.SetSize(1100, 800)
	f.tester.Frame()
	f.pending.drain(t)
	stored.orderMu.Lock()
	stored.presentGate = nil
	stored.orderMu.Unlock()
	raw, err := json.Marshal(map[string]string{"card": cards[0], "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	var tab string
	f.shell.Registry().RunLater("core.card.add-tab", raw, func(value any, err error) {
		if err != nil {
			t.Errorf("core.card.add-tab failed: %v", err)
			return
		}
		tab = value.(map[string]string)["tab"]
	})
	f.pending.drain(t)
	f.tester.Frame()
	f.pending.drain(t)
	gate.open()
	f.settle()
	f.settle()
	target, ok := stored.keyboardTarget()
	if tab == "" || !ok || target == nil || *target != tab {
		t.Fatalf("the keyboard is in %s, not in the new tab %q", describeTarget(target), tab)
	}
}

// gatedPlacement starts a placement whose presentSurfaces waits until the returned gate opens, so the window draws and
// takes input while the placement runs.
func gatedPlacement(t *testing.T, f *shellFixture, stored *surfaceHost) *gate {
	t.Helper()
	gate := newGate()
	stored.orderMu.Lock()
	stored.presentGate = gate
	stored.orderMu.Unlock()
	// A new size moves the surfaces, so a placement starts and waits in presentSurfaces.
	f.tester.SetSize(1100, 800)
	f.tester.Frame()
	f.pending.drain(t)
	stored.orderMu.Lock()
	stored.presentGate, stored.keyboard, stored.decided = nil, nil, nil
	stored.orderMu.Unlock()
	return gate
}

// keyboardRelease presses and releases the element name, which draws the pass that the release asks for, and runs the steps that
// follow it.
func keyboardRelease(t *testing.T, f *shellFixture, name string) {
	t.Helper()
	node, ok := exposedNode(f.tester.ElementTree(), name, "")
	if !ok {
		t.Fatalf("the workbench shows no %s", name)
	}
	f.tester.ClickAt(node.Bounds.X+node.Bounds.W/2, node.Bounds.Y+node.Bounds.H/2)
	f.pending.drain(t)
}

// keyboardCalls returns the targets of the keyboard calls that the host had and whether each carried decided.
func (h *surfaceHost) keyboardCalls() ([]*string, []bool) {
	h.orderMu.Lock()
	defer h.orderMu.Unlock()
	return slices.Clone(h.keyboard), slices.Clone(h.decided)
}

// A release while a placement runs is answered by the pass that it asks for: its decided call reaches the host before the placement
// answers (docs/spec/native-surfaces.md#keyboard-of-a-surface).
func TestAReleaseDuringAPlacementSendsItsDecisionAtOnce(t *testing.T) {
	f, stored := surfaceShell(t)
	_, active := keyboardRing(t, f)
	gate := gatedPlacement(t, f, stored)
	keyboardRelease(t, f, "core.chrome.bar")
	keyboard, decided := stored.keyboardCalls()
	gate.open()
	f.settle()
	if len(decided) != 1 || !decided[0] || keyboard[0] == nil || *keyboard[0] != *active {
		t.Fatalf("while the placement ran the release sent the keyboard calls %v decided %v, not one decided call to %s", describeTargets(keyboard), decided, *active)
	}
}

// A release while the ring is on a surface that the host does not hold yet decides for the workbench in the pass that it asks for,
// and the placement that gives the host the surface moves the keyboard to it without decided (docs/spec/native-surfaces.md#keyboard-of-a-surface).
func TestAReleaseOnASurfaceThatTheHostDoesNotHoldDecidesForTheWorkbench(t *testing.T) {
	f, stored := surfaceShell(t)
	cards, _ := keyboardCards(t, f)
	f.run("core.card.focus", map[string]string{"card": cards[0]})
	gate := gatedPlacement(t, f, stored)
	raw, err := json.Marshal(map[string]string{"card": cards[0], "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	var tab string
	f.shell.Registry().RunLater("core.card.add-tab", raw, func(value any, err error) {
		if err != nil {
			t.Errorf("core.card.add-tab failed: %v", err)
			return
		}
		tab = value.(map[string]string)["tab"]
	})
	f.pending.drain(t)
	f.tester.Frame()
	f.pending.drain(t)
	keyboardRelease(t, f, "core.chrome.bar")
	keyboard, decided := stored.keyboardCalls()
	if len(decided) != 1 || !decided[0] || keyboard[0] != nil {
		gate.open()
		t.Fatalf("the release on a surface that the host does not hold sent the keyboard calls %v decided %v, not one decided call to the workbench", describeTargets(keyboard), decided)
	}
	gate.open()
	f.settle()
	f.settle()
	keyboard, decided = stored.keyboardCalls()
	last := len(keyboard) - 1
	if tab == "" || keyboard[last] == nil || *keyboard[last] != tab || decided[last] {
		t.Fatalf("after the placement of %q the keyboard calls are %v decided %v", tab, describeTargets(keyboard), decided)
	}
	if slices.Contains(decided[1:], true) {
		t.Fatalf("the placement sent a second decided call: %v", decided)
	}
}

func describeTargets(targets []*string) []string {
	described := make([]string, len(targets))
	for i, target := range targets {
		described[i] = describeTarget(target)
	}
	return described
}

// A placement that leaves a surface out removes it from the host, and the keyboard calls go in an order of their own, which no
// placement waits for. So the placement waits for the keyboard calls to that surface that went out before it, and the host never
// refuses such a call as a call to a surface that it no longer holds (docs/spec/native-surfaces.md#keyboard-of-a-surface).
func TestAPlacementThatRemovesASurfaceWaitsForTheKeyboardCallToIt(t *testing.T) {
	f, stored := surfaceShell(t)
	cards, tabs := keyboardCards(t, f)
	focused, _ := keyboardRing(t, f)
	other := cards[0]
	if other == focused {
		other = cards[1]
	}
	gate := newGate()
	stored.orderMu.Lock()
	stored.focusGate, stored.order = gate, nil
	stored.orderMu.Unlock()
	later := func(name string, params any) {
		raw, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		f.shell.Registry().RunLater(name, raw, func(_ any, err error) {
			if err != nil {
				t.Errorf("%s failed: %v", name, err)
			}
		})
		f.pending.drain(t)
		f.tester.Frame()
		f.pending.drain(t)
	}
	// The keyboard call to the active surface of the other card waits in the host while the card closes.
	later("core.card.focus", map[string]string{"card": other})
	later("core.card.close", map[string]string{"card": other})
	if !stored.holds(tabs[other][0]) {
		calls, _ := stored.calledNow()
		t.Fatalf("the placement removed %s before the host answered the keyboard call to it: %s", tabs[other][0], calls)
	}
	stored.orderMu.Lock()
	stored.focusGate = nil
	stored.orderMu.Unlock()
	gate.open()
	f.settle()
	if stored.holds(tabs[other][0]) {
		t.Fatalf("the host still holds %s of the closed card", tabs[other][0])
	}
}

// A frame that waits for a keyboard call cancels the layout that it opened, and the cancel is a host call that goes its own way.
// While the host has not ended that layout, it holds the frames of the window, and no frame opens another one: a frame that comes
// meanwhile, such as the frame after the answer of the keyboard call, places nothing, and the frame after the cancel places the lines
// (docs/spec/hosts.md#native-views).
func TestNoFrameOpensALayoutWhileTheCancelOfTheLastIsOnItsWay(t *testing.T) {
	f, stored := surfaceShell(t)
	cards, tabs := keyboardCards(t, f)
	focused, _ := keyboardRing(t, f)
	other := cards[0]
	if other == focused {
		other = cards[1]
	}
	focus, cancel := newGate(), newGate()
	stored.orderMu.Lock()
	stored.focusGate, stored.cancelGate, stored.order = focus, cancel, nil
	stored.orderMu.Unlock()
	later := func(name string, params any) {
		raw, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		f.shell.Registry().RunLater(name, raw, func(_ any, err error) {
			if err != nil {
				t.Errorf("%s failed: %v", name, err)
			}
		})
		f.pending.drain(t)
		f.tester.Frame()
		f.pending.drain(t)
	}
	// The keyboard call to the active surface of the other card waits in the host while the card closes, so the frame of the close
	// cancels the layout that it opened, and the cancel waits in the host.
	later("core.card.focus", map[string]string{"card": other})
	later("core.card.close", map[string]string{"card": other})
	stored.orderMu.Lock()
	stored.focusGate = nil
	stored.orderMu.Unlock()
	focus.open()
	f.settle()
	if !stored.holds(tabs[other][0]) {
		calls, _ := stored.calledNow()
		t.Fatalf("a frame placed the lines before the host ended the cancelled layout: %s", calls)
	}
	stored.orderMu.Lock()
	stored.cancelGate = nil
	stored.orderMu.Unlock()
	cancel.open()
	f.settle()
	if stored.holds(tabs[other][0]) {
		t.Fatalf("the host still holds %s of the closed card", tabs[other][0])
	}
}
