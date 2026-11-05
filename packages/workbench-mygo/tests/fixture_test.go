package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// fixtureAnswer asks diagnostics.fixture as the host asks a window and returns the answer after the steps of the shell ran.
func fixtureAnswer(t *testing.T, f *shellFixture, params string) (any, error) {
	t.Helper()
	var answer any
	var failure error
	answered := false
	f.shell.Registry().Reply("diagnostics.fixture", json.RawMessage(params), nil, func(value any, err error) {
		answered, answer, failure = true, value, err
	})
	f.settle()
	if !answered {
		t.Fatal("diagnostics.fixture did not answer")
	}
	return answer, failure
}

// The state that a window check starts from: every project is closed, the common settings are the defaults with the values of the
// check, and the project of the root is open on a fresh layout.
func TestTheFixtureLeavesOneFreshProject(t *testing.T) {
	stored := &storedHost{}
	f := newShell(t, stored)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"memorySaverDelay": 7, "dim": true}, "scope": "common"})
	for _, root := range []string{"/work/alpha", "/work/beta"} {
		if err := f.finish("core.project.open", map[string]string{"root": root}); err != nil {
			t.Fatal(err)
		}
	}
	answer, err := fixtureAnswer(t, f, `{"root":"/work/check","settings":{"memorySaverDelay":9}}`)
	if err != nil {
		t.Fatal(err)
	}
	if answer.(map[string]any)["root"] != "/work/check" {
		t.Fatalf("the fixture answered %v", answer)
	}
	if len(stored.projects) != 1 || stored.projects[0]["root"] != "/work/check" || stored.projects[0]["color"] != "#ffb36b" {
		t.Fatalf("the store holds %v", stored.projects)
	}
	shown := status[map[string]any](t, f, "core.project")
	if shown["root"] != "/work/check" {
		t.Fatalf("the shell shows %v", shown)
	}
	settings := status[struct {
		Values map[string]any `json:"values"`
	}](t, f, "core.settings")
	if settings.Values["memorySaverDelay"] != float64(9) || settings.Values["dim"] != false {
		t.Fatalf("the settings are memorySaverDelay %v and dim %v", settings.Values["memorySaverDelay"], settings.Values["dim"])
	}
}

// A window without a project takes the fixture too: that is the state of a window that a check opens first.
func TestTheFixtureOpensAProjectInAnEmptyWindow(t *testing.T) {
	stored := &storedHost{}
	f := newShell(t, stored)
	if _, err := fixtureAnswer(t, f, `{"root":"/work/check"}`); err != nil {
		t.Fatal(err)
	}
	if len(stored.projects) != 1 || stored.projects[0]["root"] != "/work/check" {
		t.Fatalf("the store holds %v", stored.projects)
	}
}

// The root names the project of the fixture, so a request without it has nothing to open.
func TestTheFixtureRefusesAMissingRoot(t *testing.T) {
	f := newShell(t, &storedHost{})
	if _, err := fixtureAnswer(t, f, `{}`); err == nil || err.Error() != "diagnostics.fixture requires root" {
		t.Fatalf("the request failed with %v", err)
	}
}

// A window check reads a failed placement from core.verify, and the next placement that the host presents clears it.
func TestTheVerificationStatesAFailedPresentation(t *testing.T) {
	refused := false
	stored := &surfaceHost{window: workbench.WindowView{Visible: true, Scale: 2, Width: 1200, Height: 800}}
	stored.calls = map[string]workbench.HostCall{"presentSurfaces": func(context.Context, json.RawMessage) (any, error) {
		if refused {
			return nil, errors.New("the ticket is stale")
		}
		return []any{}, nil
	}}
	f := surfaceShellOn(t, installedDocument, stored)
	place := func(width int) workbench.VerifyStatus {
		t.Helper()
		f.tester.SetSize(width, 800)
		for range 2 {
			f.pending.drain(t)
			f.tester.Frame()
		}
		f.pending.drain(t)
		return status[workbench.VerifyStatus](t, f, "core.verify")
	}
	refused = true
	verify := place(1000)
	if verify.Failed != 1 || len(verify.Rows) != 1 || verify.Rows[0].Name != "Surface presentation" ||
		verify.Rows[0].OK || verify.Rows[0].Note != "the ticket is stale" {
		t.Fatalf("core.verify is %+v", verify)
	}
	refused = false
	if verify = place(1100); verify.Failed != 0 || len(verify.Rows) != 0 {
		t.Fatalf("core.verify is %+v", verify)
	}
}

// The host stores the policy that the setting diagnostics.log gives: a class that the setting does not name stores the errors, and
// the same policy is not stored again.
func TestTheLogSettingStoresThePolicyOfTheEventLog(t *testing.T) {
	stored := &storedHost{}
	f := newShell(t, stored)
	want := map[string]string{"lifecycle": "error", "input": "error", "call": "debug", "io": "error", "frame": "error"}
	before := len(stored.policies)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"diagnostics.log": map[string]string{"call": "debug"}}, "scope": "common"})
	if len(stored.policies) != before+1 || !maps.Equal(stored.policies[before], want) {
		t.Fatalf("the host stored %v", stored.policies[before:])
	}
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"memorySaverDelay": 7}, "scope": "common"})
	if len(stored.policies) != before+1 {
		t.Fatalf("the host stored %v", stored.policies[before:])
	}
}

// A window that starts puts the stored setting in force: the file of a page that ended can hold another policy.
func TestAStartStoresThePolicyOfTheStoredSetting(t *testing.T) {
	stored := &storedHost{}
	newShell(t, stored)
	want := map[string]string{"lifecycle": "error", "input": "error", "call": "error", "io": "error", "frame": "error"}
	if len(stored.policies) != 1 || !maps.Equal(stored.policies[0], want) {
		t.Fatalf("the host stored %v", stored.policies)
	}
}

// The switch of the performance trace of the host follows the setting; a window that starts reports it, because the switch can be
// on from a window that ended.
func TestTheTraceSwitchFollowsTheSetting(t *testing.T) {
	stored := &storedHost{}
	f := newShell(t, stored)
	if !slices.Equal(stored.traces, []string{"off"}) {
		t.Fatalf("the start reported %v", stored.traces)
	}
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"diagnostics.performance": true}, "scope": "common"})
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"memorySaverDelay": 7}, "scope": "common"})
	if !slices.Equal(stored.traces, []string{"off", "on"}) {
		t.Fatalf("the host received %v", stored.traces)
	}
}
