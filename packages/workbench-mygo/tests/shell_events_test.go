package workbench_test

import (
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

// storedSettings reports that the host stored count settings, on the goroutine of a host call.
func storedSettings(stored *storedHost, count int) func() bool {
	return func() bool {
		stored.mu.Lock()
		defer stored.mu.Unlock()
		return len(stored.settings) == count
	}
}

func TestTheMenuRunsTheTextSizeCommands(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "menu-command", map[string]any{"name": "core.text.larger"})
	queue.until(t, storedSettings(stored, 1))
	app.Emit(window, "menu-command", map[string]any{"name": "core.text.reset"})
	queue.until(t, storedSettings(stored, 2))
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
	queue.until(t, storedSettings(stored, 1))
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
