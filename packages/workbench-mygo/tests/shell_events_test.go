package workbench_test

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestAnUnknownEventGoesToTheErrorRecord(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Emit(window, "no-such-event")
	queue.until(t, func() bool { return len(stored.written("workbench.record.error")) == 1 })
	fields := stored.written("workbench.record.error")[0]["fields"].(map[string]any)
	if !strings.Contains(fields["text"].(string), "no-such-event") {
		t.Fatalf("the record is %v", fields)
	}
}

func TestAnEventThatTheWorkbenchLeavesIsNoError(t *testing.T) {
	app, window, queue, _ := fixtureApp(t, &storedHost{})
	app.Build(window)
	for _, name := range []string{"theme", "workspace-changed", "page-ready", "notification-activated", "view-call", "document-state"} {
		app.Emit(window, name, map[string]any{})
	}
	queue.drain(t)
}

func TestTheMenuRunsTheTextSizeCommands(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "menu-command", map[string]any{"name": "core.text.larger"})
	queue.drain(t)
	app.Emit(window, "menu-command", map[string]any{"name": "core.text.reset"})
	queue.drain(t)
	if len(stored.settings) != 2 {
		t.Fatalf("the menu stored %v", stored.settings)
	}
	if larger := stored.settings[0]["patch"].(map[string]any)["textSize"]; larger == nil || larger.(float64) <= 1 {
		t.Fatalf("the larger item stored %v", stored.settings[0])
	}
	if reset := stored.settings[1]["patch"].(map[string]any)["textSize"]; reset != 1.0 {
		t.Fatalf("the default item stored %v", stored.settings[1])
	}
}

func TestTheStoredFrameTextSizeIsReadAtTheStart(t *testing.T) {
	stored := &storedHost{common: map[string]any{"textSize": 1.25}}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "menu-command", map[string]any{"name": "core.text.smaller"})
	queue.drain(t)
	if len(stored.settings) != 1 || stored.settings[0]["patch"].(map[string]any)["textSize"] == nil || stored.settings[0]["patch"].(map[string]any)["textSize"].(float64) >= 1.25 {
		t.Fatalf("the smaller item stored %v", stored.settings)
	}
}

func TestTheDebugMenuOpensTheDebugView(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	view := app.Build(window)
	app.Shown(window)
	queue.drain(t)
	tester := ui.NewTester(view, 900, 700)
	tester.Frame()
	if slices.Contains(tester.Texts(), "newer.log") {
		t.Fatal("the debug view shows before the menu opened it")
	}
	app.Emit(window, "menu-command", map[string]any{"name": "core.debug.open"})
	queue.drain(t)
	tester.Frame()
	texts := tester.Texts()
	at, older := slices.Index(texts, "newer.log"), slices.Index(texts, "older.log")
	if at < 0 || older < at {
		t.Fatalf("the debug view shows %q, want the newest file first", texts)
	}
}

// The settings item of the app menu opens the settings window, which takes the keyboard (docs/spec/exposure.md#keyboard-shortcuts).
func TestTheSettingsItemOfTheMenuOpensTheSettingsWindow(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	view := app.Build(window)
	app.Shown(window)
	queue.drain(t)
	tester := ui.NewTester(view, 900, 700)
	tester.Frame()
	if slices.Contains(tester.Texts(), "일반") {
		t.Fatal("the settings window shows before the menu opened it")
	}
	app.Emit(window, "menu-command", map[string]any{"name": "core.settings.open"})
	queue.drain(t)
	tester.Frame()
	if !slices.Contains(tester.Texts(), "일반") {
		t.Fatalf("the menu did not open the settings window: %q", tester.Texts())
	}
}

func TestAMenuCommandThatFailsGoesToTheErrorRecord(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Emit(window, "menu-command", map[string]any{"name": "core.none"})
	queue.until(t, func() bool { return len(stored.written("workbench.record.error")) == 1 })
	fields := stored.written("workbench.record.error")[0]["fields"].(map[string]any)
	if !strings.Contains(fields["text"].(string), "core.none") {
		t.Fatalf("the record is %v", fields)
	}
}

func TestTheDebugViewShowsAFileAndSavesIt(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	view := app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "menu-command", map[string]any{"name": "core.debug.open"})
	queue.drain(t)
	app.Emit(window, "exposure-request", map[string]any{"id": 1, "method": "command.run",
		"params": map[string]any{"name": "core.debug.view", "params": map[string]string{"path": "newer.log"}}})
	queue.drain(t)
	tester := ui.NewTester(view, 900, 700)
	tester.Frame()
	if !slices.Contains(tester.Texts(), "text of newer.log") {
		t.Fatalf("the debug view shows %q", tester.Texts())
	}
	if !slices.Contains(stored.calls, "debugRecord") {
		t.Fatalf("opening called %v, want the state recorded", stored.calls)
	}
	app.Emit(window, "exposure-request", map[string]any{"id": 2, "method": "command.run",
		"params": map[string]any{"name": "core.debug.close", "params": map[string]any{}}})
	queue.drain(t)
	tester.Frame()
	if slices.Contains(tester.Texts(), "text of newer.log") {
		t.Fatal("the debug view stayed after its close")
	}
}

// The host reloads the window after the answer of this command, so the answer comes when the store holds what the window held.
func TestTheFlushOfTheProjectsAnswersWhenTheStoreHoldsThem(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}}
	f := newTabShell(t, stored)
	f.open(t)
	stored.calls = nil
	answered := false
	f.shell.Registry().RunLater("core.projects.flush", json.RawMessage(`{}`), func(_ any, err error) {
		if err != nil {
			t.Error(err)
		}
		answered = true
	})
	if answered {
		t.Fatal("the flush answered before the store")
	}
	f.settle()
	if !answered {
		t.Fatal("the flush did not answer")
	}
	for _, name := range []string{"workspace", "windowState"} {
		if !slices.Contains(stored.calls, name) {
			t.Fatalf("the flush made no call %s: %v", name, stored.calls)
		}
	}
}

// The reload that follows a flush would lose what did not reach the store, so the host hears of a store that failed.
func TestAFlushOfTheProjectsAnswersAStoreThatFailed(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}}
	f := newTabShell(t, stored)
	f.open(t)
	stored.failing = map[string]error{"workspace": errors.New("the disk is full")}
	var failure error
	f.shell.Registry().RunLater("core.projects.flush", json.RawMessage(`{}`), func(_ any, err error) { failure = err })
	f.settle()
	if failure == nil || !strings.Contains(failure.Error(), "the disk is full") {
		t.Fatalf("the flush answered %v", failure)
	}
}
