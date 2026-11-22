package workbench_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The core.tab.reload command restarts the view of its tab through the host, and it answers the tab.
// contract: view.reload.restarts-once
func TestTheReloadCommandRestartsTheViewOfItsTab(t *testing.T) {
	stored := &surfaceHost{window: workbench.WindowView{Visible: true, Scale: 2, Width: 1200, Height: 800}}
	var reloaded []string
	stored.extra = map[string]workbench.HostCall{"viewReload": func(_ context.Context, argument json.RawMessage) (any, error) {
		var req struct {
			Surface string `json:"surface"`
		}
		if err := json.Unmarshal(argument, &req); err != nil {
			return nil, err
		}
		reloaded = append(reloaded, req.Surface)
		return nil, nil
	}}
	f := surfaceShellOn(t, installedDocument, stored)
	f.settle()
	id := firstSurfaceOf(stored, t)
	answer := f.answerText("core.tab.reload", map[string]string{"tab": id})
	if !slices.Equal(reloaded, []string{id}) {
		t.Fatalf("view reloads %v, want one reload of %s", reloaded, id)
	}
	if want := `{"tab":"` + id + `"}`; answer != want {
		t.Fatalf("the reload answer %s, want %s", answer, want)
	}
}

// A reload of a tab without a view is refused, and the refusal names the tab.
// contract: view.reload.refuses-unknown-tab
func TestTheReloadCommandRefusesAnUnknownTabWithItsId(t *testing.T) {
	stored := &surfaceHost{window: workbench.WindowView{Visible: true, Scale: 2, Width: 1200, Height: 800}}
	stored.extra = map[string]workbench.HostCall{"viewReload": func(_ context.Context, argument json.RawMessage) (any, error) {
		var req struct {
			Surface string `json:"surface"`
		}
		if err := json.Unmarshal(argument, &req); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("tab %s: no view to reload", req.Surface)
	}}
	f := surfaceShellOn(t, installedDocument, stored)
	f.settle()
	var failure error
	f.shell.Registry().RunLater("core.tab.reload", []byte(`{"tab":"tab-unknown"}`), func(_ any, err error) { failure = err })
	f.settle()
	if failure == nil || !strings.Contains(failure.Error(), "tab-unknown") {
		t.Fatalf("the reload of an unknown tab failed with %v, want an error that names tab-unknown", failure)
	}
}

// firstSurfaceOf returns the identifier of the first surface of the stored window.
func firstSurfaceOf(stored *surfaceHost, t *testing.T) string {
	t.Helper()
	for id := range stored.lastSurfaces(t) {
		return id
	}
	t.Fatal("the stored window has no surface")
	return ""
}

// A failed surface shows the control that runs core.tab.reload of its tab.
// contract: view.reload.restarts-once
func TestTheFailedSurfaceShowsAReloadControlThatRunsTheCommand(t *testing.T) {
	stored := &surfaceHost{window: workbench.WindowView{Visible: true, Scale: 2, Width: 1200, Height: 800}}
	var reloaded []string
	stored.extra = map[string]workbench.HostCall{"viewReload": func(_ context.Context, argument json.RawMessage) (any, error) {
		var req struct {
			Surface string `json:"surface"`
		}
		if err := json.Unmarshal(argument, &req); err != nil {
			return nil, err
		}
		reloaded = append(reloaded, req.Surface)
		return nil, nil
	}}
	f := surfaceShellOn(t, installedDocument, stored)
	id := firstSurfaceOf(stored, t)
	f.settle()
	f.shell.Event("view-stopped", []any{map[string]any{"surface": id, "plugin": "textprobe", "reason": "the view failed"}})
	f.pending.drain(t)
	f.tester.Frame()
	if err := f.tester.Click("다시 불러오기"); err != nil {
		t.Fatalf("the failed surface has no reload control: %v", err)
	}
	// The failed view writes its record, which settle would refuse, so the pending steps drain without it.
	f.pending.drain(t)
	f.tester.Frame()
	f.pending.drain(t)
	if !slices.Equal(reloaded, []string{id}) {
		t.Fatalf("the control reloaded %v, want one reload of %s", reloaded, id)
	}
}
