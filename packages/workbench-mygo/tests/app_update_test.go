// The application update of a window: the status core.app, its commands, and what the plugin page shows of it.
package workbench_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

const appRelease = "https://github.com/soksak-app/core/releases/download/v2.0.0/soksak-2.0.0-darwin-arm64.zip"

type updateStatus struct {
	Version   *string
	Available *struct {
		Version string
		Release *string
	}
	Operation *struct {
		State, Version string
		Error          *string
	}
	Error        *string
	Incompatible []struct {
		ID, Installed, Range string
		Compatible           *string
	}
}

func listed(version, engine string) map[string]any {
	return map[string]any{"version": version, "engines": map[string]string{"soksak": engine}, "sidecars": map[string]string{}}
}

// updateShell is a window whose host lists core 2.0.0, shown on the plugin page.
func updateShell(t *testing.T, candidate string) (*shellFixture, *storedHost) {
	t.Helper()
	record := func(version string) map[string]any {
		return map[string]any{"version": version, "enabled": true, "sidecars": map[string]string{}}
	}
	plugins := &pluginsHost{core: "1.0.0", registry: "file:///index.json", plugins: map[string]map[string]any{
		"beta": record("1.0.0"), "alpha": record("1.0.0"), "gamma": record("9.9.9"), "delta": record("1.0.0")},
		index: map[string]any{"format": 1, "sidecars": []any{}, "packs": []any{}, "plugins": []any{
			map[string]any{"id": "alpha", "name": "alpha", "description": "a", "versions": []any{listed("1.0.0", "^1.0.0"), listed("1.1.0", "^2.0.0"), listed("1.2.0", "^2.0.0"), listed("1.3.0", "^2.0.0")}},
			map[string]any{"id": "beta", "name": "beta", "description": "b", "versions": []any{listed("1.0.0", "^1.0.0")}},
			map[string]any{"id": "gamma", "name": "gamma", "description": "c", "versions": []any{listed("1.0.0", "^1.0.0")}},
			map[string]any{"id": "delta", "name": "delta", "description": "d", "versions": []any{listed("1.0.0", ">=1.0.0")}}},
			"revoked": map[string]any{"sidecars": []any{}, "plugins": []any{map[string]any{"id": "alpha", "version": "1.3.0", "reason": "broken"}}}}}
	stored := &storedHost{plugins: plugins, appUpdate: map[string]any{"version": "1.0.0", "available": nil}}
	if candidate != "" {
		stored.appUpdate = map[string]any{"version": "1.0.0", "available": map[string]any{"version": "2.0.0",
			"release": map[string]string{"url": candidate, "sha256": strings.Repeat("0", 64)}}}
	}
	f := newShell(t, stored)
	f.do("core.library.page", map[string]string{"page": "plugins"})
	f.settle()
	return f, stored
}

func (f *shellFixture) appUpdateStatus() updateStatus {
	f.t.Helper()
	value, err := f.shell.Registry().Read("core.app")
	if err != nil {
		f.t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	var status updateStatus
	if err := json.Unmarshal(encoded, &status); err != nil {
		f.t.Fatal(err)
	}
	return status
}

func TestCoreAppReportsTheCandidateAndThePluginsThatDoNotFitIt(t *testing.T) {
	f, _ := updateShell(t, appRelease)
	status := f.appUpdateStatus()
	if status.Version == nil || *status.Version != "1.0.0" || status.Available == nil || status.Available.Version != "2.0.0" {
		t.Fatalf("the status is %+v", status)
	}
	if page := "https://github.com/soksak-app/core/releases/tag/v2.0.0"; status.Available.Release == nil || *status.Available.Release != page {
		t.Fatalf("the release page is %v", status.Available.Release)
	}
	if status.Operation != nil || status.Error != nil {
		t.Fatalf("the status is %+v", status)
	}
	var got []string
	for _, item := range status.Incompatible {
		line := item.ID + " " + item.Installed + " " + item.Range + " "
		if item.Compatible != nil {
			line += *item.Compatible
		}
		got = append(got, line)
	}
	if want := []string{"alpha 1.0.0 ^1.0.0 1.2.0", "beta 1.0.0 ^1.0.0 "}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the incompatible plugins are %q, want %q", got, want)
	}
	if !f.tester.HasText("core: 1.0.0 → 2.0.0") {
		t.Fatalf("the plugin page shows %q", f.tester.Texts())
	}
}

func TestTheUpdateControlCountsTheApplicationUpdate(t *testing.T) {
	f, _ := updateShell(t, appRelease)
	if !f.has("core.chrome.updates", "") {
		t.Fatalf("the window has no control of the updates; the texts are %q", f.tester.Texts())
	}
	if want := fmt.Sprintf("업데이트 %d", len(f.pluginStatus().Updates)+1); !f.tester.HasText(want) {
		t.Fatalf("the window does not show %q: %q", want, f.tester.Texts())
	}
}

func TestARegistryURLThatIsNoReleaseHasNoReleasePage(t *testing.T) {
	f, stored := updateShell(t, "file:///releases/soksak-2.0.0.zip")
	if status := f.appUpdateStatus(); status.Available == nil || status.Available.Release != nil {
		t.Fatalf("the status is %+v", status)
	}
	if err := f.finish("core.app.release", struct{}{}); err == nil || err.Error() != "the application update has no release page" {
		t.Fatalf("the command answered %v", err)
	}
	if len(stored.opened) != 0 {
		t.Fatalf("the host opened %s", stored.opened)
	}
}

func TestCoreAppReleaseOpensTheReleasePage(t *testing.T) {
	f, stored := updateShell(t, appRelease)
	if err := f.finish("core.app.release", struct{}{}); err != nil {
		t.Fatal(err)
	}
	if len(stored.opened) != 1 || string(stored.opened[0]) != `{"url":"https://github.com/soksak-app/core/releases/tag/v2.0.0"}` {
		t.Fatalf("the host opened %s", stored.opened)
	}
}

func TestAFailedReadIsTheErrorOfCoreApp(t *testing.T) {
	f, stored := updateShell(t, appRelease)
	stored.failing = map[string]error{"appUpdateState": errors.New("the index is unreadable")}
	f.shell.Event("window-active", nil)
	f.settle()
	status := f.appUpdateStatus()
	if status.Error == nil || !strings.Contains(*status.Error, "the index is unreadable") || status.Version != nil || status.Available != nil {
		t.Fatalf("the status is %+v", status)
	}
	if len(status.Incompatible) != 0 {
		t.Fatalf("the status is %+v", status)
	}
}

func TestCoreAppUpdateStagesAndAppliesTheCandidate(t *testing.T) {
	f, stored := updateShell(t, appRelease)
	stored.calls = nil
	if err := f.finish("core.app.update", struct{}{}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"appUpdateStage", "appUpdateApply"}; !reflect.DeepEqual(filterCalls(stored.calls, "appUpdate"), want) {
		t.Fatalf("the host calls are %v", stored.calls)
	}
	if status := f.appUpdateStatus(); status.Operation == nil || status.Operation.State != "applying" || status.Operation.Version != "2.0.0" {
		t.Fatalf("the status is %+v", status)
	}
}

func TestAFailedStageIsTheOperationOfCoreApp(t *testing.T) {
	f, stored := updateShell(t, appRelease)
	stored.failing = map[string]error{"appUpdateStage": errors.New("no space")}
	var failure error
	f.shell.Registry().RunLater("core.app.update", json.RawMessage(`{}`), func(_ any, err error) { failure = err })
	f.pending.drain(t)
	f.tester.Frame()
	f.pending.drain(t)
	f.tester.Frame()
	if failure == nil || !strings.Contains(failure.Error(), "no space") {
		t.Fatalf("the command answered %v", failure)
	}
	status := f.appUpdateStatus()
	if status.Operation == nil || status.Operation.State != "failed" || status.Operation.Error == nil || !strings.Contains(*status.Operation.Error, "no space") {
		t.Fatalf("the status is %+v", status)
	}
	if !strings.Contains(strings.Join(f.tester.Texts(), " "), "2.0.0 업데이트하지 못했습니다: ") {
		t.Fatalf("the plugin page shows %q", f.tester.Texts())
	}
}

func TestCoreAppUpdateWithoutACandidateFails(t *testing.T) {
	f, stored := updateShell(t, "")
	stored.calls = nil
	if err := f.finish("core.app.update", struct{}{}); err == nil || err.Error() != "no application update is available" {
		t.Fatalf("the command answered %v", err)
	}
	if got := filterCalls(stored.calls, "appUpdateSt"); len(got) != 0 {
		t.Fatalf("the host calls are %v", got)
	}
}

// filterCalls returns the calls whose name starts with prefix.
func filterCalls(calls []string, prefix string) []string {
	var found []string
	for _, name := range calls {
		if strings.HasPrefix(name, prefix) {
			found = append(found, name)
		}
	}
	return found
}
