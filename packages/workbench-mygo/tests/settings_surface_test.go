package workbench_test

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The settings view of a plugin (docs/spec/plugins.md#settings-views): the plugin page of the settings window shows the page that the
// plugin declares as settingsView at the seat core.settings-modal.plugin-view, as the settings surface settings/<plugin>, which exists
// while the window shows that page (F1128-2).

const settingsSurfaceID = "settings/textprobe"

// settingsViewShell is a shell whose plugin textprobe declares a settings view with the document region login.
func settingsViewShell(t *testing.T) (*shellFixture, *surfaceHost) {
	t.Helper()
	document := strings.Replace(installedDocument, `"surface": {"menu": [{"title": "닫기"`,
		`"settingsView": {"page": "ui/settings.html", "regions": [{"name": "login", "kind": "document", "input": "native"}]}, "surface": {"menu": [{"title": "닫기"`, 1)
	if document == installedDocument {
		t.Fatal("the installed document holds no textprobe surface to declare the settings view beside")
	}
	return surfaceShellOf(t, document)
}

// showPluginPage opens the settings window on the plugin page of textprobe.
func showPluginPage(f *shellFixture) {
	f.t.Helper()
	// The search of the plugins section draws a symbol of the system, which the surface fixture does not set.
	f.tester.SetSystemSymbols(squareSymbols)
	f.click("core.chrome.settings", "")
	f.run("core.settings-modal.nav", map[string]any{"section": "plugins"})
	f.run("core.settings-modal.plugin", map[string]any{"plugin": "textprobe"})
}

func TestThePluginPageShowsTheSettingsViewOfItsPluginAsASettingsSurface(t *testing.T) {
	f, stored := settingsViewShell(t)
	showPluginPage(f)
	placed := stored.lastSurfaces(t)[settingsSurfaceID]
	if placed == nil || placed["visible"] != true {
		t.Fatalf("the settings surface is not placed visible: %v", placed)
	}
	start, _ := json.Marshal(placed["start"].(map[string]any))
	for _, member := range []string{`"params":null`, `"origin":{"directory":null}`, `"section":null`, `"dialog":null`} {
		if !strings.Contains(string(start), member) {
			t.Fatalf("the settings surface starts with %s, without %s", start, member)
		}
	}
	composition, _ := json.Marshal(placed["composition"])
	if want := `{"kind":"view","page":"ui/settings.html","regions":[{"input":"native","kind":"document","name":"login"}]}`; string(composition) != want {
		t.Fatalf("the settings surface has the composition %s, want %s", composition, want)
	}
	if !f.has("core.settings-modal.plugin-view", "") || !f.has("core.settings-modal.pane", "") {
		t.Fatal("the plugin page has no seat of the settings view or no pane")
	}
	if surfaces := f.status("core.surfaces"); !strings.Contains(surfaces, `"surface":"settings/textprobe"`) || !strings.Contains(surfaces, `"kind":"settings"`) {
		t.Fatalf("core.surfaces does not list the settings surface: %s", surfaces)
	}
	dialogCall(f, settingsSurfaceID, 6, "composition.declaration", nil)
	reply := replyOf(stored, settingsSurfaceID, 6)
	declared, _ := json.Marshal(reply["result"])
	if want := `{"kind":"view","overlays":[],"regions":[{"input":"native","kind":"document","name":"login"}]}`; reply == nil || reply["error"] != nil || string(declared) != want {
		t.Fatalf("the settings view read the composition %v %s, want %s", reply, declared, want)
	}
	// The surface leaves the layout when the window shows another page and when it closes.
	f.run("core.settings-modal.plugin", map[string]any{"plugin": nil})
	if _, placed := stored.lastSurfaces(t)[settingsSurfaceID]; placed || f.has("core.settings-modal.plugin-view", "") {
		t.Fatal("the settings surface stays after the window left the plugin page")
	}
	f.run("core.settings-modal.plugin", map[string]any{"plugin": "textprobe"})
	if _, placed := stored.lastSurfaces(t)[settingsSurfaceID]; !placed {
		t.Fatal("the settings surface is not placed again when the window shows the plugin page again")
	}
	f.run("core.settings.close", map[string]any{})
	if _, placed := stored.lastSurfaces(t)[settingsSurfaceID]; placed {
		t.Fatal("the settings surface stays after the settings window closed")
	}
}

func TestAPluginWithoutASettingsViewHasNoSeatAndNoSettingsSurface(t *testing.T) {
	f, stored := surfaceShellOf(t, installedDocument)
	showPluginPage(f)
	if _, placed := stored.lastSurfaces(t)[settingsSurfaceID]; placed || f.has("core.settings-modal.plugin-view", "") {
		t.Fatal("a plugin without a settings view has a settings surface or a seat")
	}
}

// A press on the settings surface gives it the keyboard, as a press on a tab view does, and a press elsewhere in the settings window
// gives the keyboard back to the settings window.
func TestAPressOnTheSettingsSurfaceGivesItTheKeyboard(t *testing.T) {
	f, stored := settingsViewShell(t)
	showPluginPage(f)
	f.shell.Event("surface-pressed", []any{settingsSurfaceID})
	f.settle()
	keyboard, _ := stored.keyboardCalls()
	if len(keyboard) == 0 || keyboard[len(keyboard)-1] == nil || *keyboard[len(keyboard)-1] != settingsSurfaceID {
		t.Fatalf("the keyboard calls after the press are %v", targets(keyboard))
	}
	f.shell.Event("window-responder", []any{map[string]any{"owner": "workbench", "surface": nil, "document": nil}})
	f.settle()
	keyboard, _ = stored.keyboardCalls()
	if last := keyboard[len(keyboard)-1]; last != nil {
		t.Fatalf("after a press on the settings window the keyboard is with %s", *last)
	}
}

// A settings surface whose view stopped its restarts is removed, its reason shows at settings <plugin>, and the window creates it again
// only when it shows the page of the plugin again.
func TestAStoppedSettingsViewIsRemovedUntilItsPageIsShownAgain(t *testing.T) {
	f, stored := settingsViewShell(t)
	showPluginPage(f)
	f.shownRecords()
	reason := "the view failed 4 times within 300 seconds and is created again when the settings page of the plugin is shown again"
	f.shell.Event("view-stopped", []any{map[string]any{"surface": settingsSurfaceID, "reason": reason}})
	if got := f.shownRecords(); len(got) != 1 || got[0].where != "settings textprobe" || got[0].text != reason {
		t.Fatalf("the shown records of the stopped settings view are %q", got)
	}
	if _, placed := stored.lastSurfaces(t)[settingsSurfaceID]; placed {
		t.Fatal("the stopped settings surface is still placed")
	}
	f.run("core.settings-modal.plugin", map[string]any{"plugin": nil})
	f.run("core.settings-modal.plugin", map[string]any{"plugin": "textprobe"})
	if placed := stored.lastSurfaces(t)[settingsSurfaceID]; placed == nil || placed["visible"] != true {
		t.Fatal("the settings surface is not created again when its page is shown again")
	}
}

// targets returns the keyboard targets as text, "workbench" for nil.
func targets(keyboard []*string) []string {
	texts := make([]string, len(keyboard))
	for i, target := range keyboard {
		texts[i] = "workbench"
		if target != nil {
			texts[i] = *target
		}
	}
	return texts
}

// The settings surface stands in its seat in the settings window, so the open settings window does not stand over its document: an
// action on its element reaches it (docs/spec/exposure.md).
func TestTheSettingsWindowDoesNotStandOverTheSettingsSurface(t *testing.T) {
	var mu sync.Mutex
	var replies, forwards []string
	record := func(into *[]string) workbench.HostCall {
		return func(_ context.Context, argument json.RawMessage) (any, error) {
			mu.Lock()
			defer mu.Unlock()
			*into = append(*into, string(argument))
			return nil, nil
		}
	}
	stored := &surfaceHost{extra: map[string]workbench.HostCall{"exposureReply": record(&replies), "exposureForward": record(&forwards)}}
	document := strings.Replace(installedDocument, `"surface": {"menu": [{"title": "닫기"`,
		`"settingsView": {"page": "ui/settings.html"}, "surface": {"menu": [{"title": "닫기"`, 1)
	f := surfaceShellOn(t, document, stored)
	showPluginPage(f)
	f.shell.Event("exposure-registered", []any{map[string]any{"surface": settingsSurfaceID, "kind": "element", "name": "textprobe.view"}})
	f.settle()
	f.shell.Event("exposure-request", []any{map[string]any{"id": 1, "method": "element.act",
		"params": json.RawMessage(`{"name":"textprobe.view","action":"click","surface":"` + settingsSurfaceID + `"}`)}})
	f.settle()
	mu.Lock()
	defer mu.Unlock()
	if len(forwards) != 1 || strings.Contains(strings.Join(replies, " "), "behind the open dialog") {
		t.Fatalf("the action on the settings surface was forwarded %d times and answered %v", len(forwards), replies)
	}
}

// The sync request carries the clip of the settings surface, the pane of the settings window on device pixels, which the host requires
// of a settings surface and refuses without (docs/spec/native-modals.md#settings-surface, F1200).
func TestTheSettingsSurfaceCarriesThePaneAsItsClip(t *testing.T) {
	f, stored := settingsViewShell(t)
	showPluginPage(f)
	placed := stored.lastSurfaces(t)[settingsSurfaceID]
	clip, _ := placed["clip"].(map[string]any)
	if clip == nil {
		t.Fatalf("the settings surface is placed without a clip: %v", placed)
	}
	pane := element(t, f.tester, "core.settings-modal.pane", "").Bounds
	want := workbench.DevicePixels(layout.Rect{X: float64(pane.X), Y: float64(pane.Y), W: float64(pane.W), H: float64(pane.H)}, stored.window.Scale)
	got := layout.Rect{X: clip["x"].(float64), Y: clip["y"].(float64), W: clip["w"].(float64), H: clip["h"].(float64)}
	if got != want {
		t.Fatalf("the settings surface has the clip %+v, want the pane %+v", got, want)
	}
	for id, other := range stored.lastSurfaces(t) {
		if _, clipped := other["clip"]; clipped && id != settingsSurfaceID {
			t.Fatalf("the surface %s carries a clip: %v", id, other)
		}
	}
}

// A window without a project shows the settings view of a plugin, whose start value project is null
// (docs/spec/plugins.md#settings-views, F1204).
func TestTheSettingsSurfaceOfAWindowWithoutAProjectStartsWithANullProject(t *testing.T) {
	f, stored := settingsViewShell(t)
	f.run("core.project.close", map[string]string{"id": f.host.projects[0]["id"].(string)})
	showPluginPage(f)
	placed := stored.lastSurfaces(t)[settingsSurfaceID]
	if placed == nil || placed["visible"] != true {
		t.Fatalf("the settings surface of a window without a project is not placed visible: %v", placed)
	}
	start := placed["start"].(map[string]any)
	if project, held := start["project"]; !held || project != nil {
		t.Fatalf("the settings surface of a window without a project starts with the project %v, want null", start["project"])
	}
}
