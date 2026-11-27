package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"sync"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// setupHost answers the setup calls of a test: each setupState takes the next of states, each setupInstall the next of installs,
// and installs records the argument of each install.
type setupHost struct {
	mu       sync.Mutex
	states   []setupAnswer
	installs []setupAnswer
	args     []string
	reads    int
}

// setupAnswer is the parts of an answer, or its error.
type setupAnswer struct {
	parts []map[string]any
	err   error
}

func (h *setupHost) calls() map[string]workbench.HostCall {
	take := func(answers *[]setupAnswer, name string) (any, error) {
		h.mu.Lock()
		defer h.mu.Unlock()
		if len(*answers) == 0 {
			return nil, errors.New("the test has no answer of " + name)
		}
		answer := (*answers)[0]
		*answers = (*answers)[1:]
		if answer.err != nil {
			return nil, answer.err
		}
		return map[string]any{"parts": answer.parts}, nil
	}
	return map[string]workbench.HostCall{
		"setupState": func(context.Context, json.RawMessage) (any, error) {
			h.mu.Lock()
			h.reads++
			h.mu.Unlock()
			return take(&h.states, "setupState")
		},
		"setupInstall": func(_ context.Context, argument json.RawMessage) (any, error) {
			h.mu.Lock()
			h.args = append(h.args, string(argument))
			h.mu.Unlock()
			return take(&h.installs, "setupInstall")
		},
	}
}

const setupSok = "/Applications/soksak.app/Contents/MacOS/sok"

func setupPart(part, file, state, reason string) map[string]any {
	steps := map[string]string{"skill": setupSok + " skill install", "mcp": setupSok + " mcp install"}
	value := map[string]any{"part": part, "file": file, "state": state, "step": steps[part]}
	if part == "path" {
		value["enabled"] = true
	}
	if reason != "" {
		value["reason"] = reason
	}
	return value
}

var (
	setupMissing = []map[string]any{
		setupPart("path", "/Users/person/.local/bin/sok", "missing", "absent"),
		setupPart("skill", "/Users/person/.claude/skills/soksak/SKILL.md", "missing", "differs"),
		setupPart("mcp", "/Users/person/.claude.json", "missing", "absent"),
		setupPart("hook", "/Users/person/.claude/settings.json", "missing", "absent"),
	}
	setupInstalled = []map[string]any{
		setupPart("path", "/Users/person/.local/bin/sok", "missing", "absent"),
		setupPart("skill", "/Users/person/.claude/skills/soksak/SKILL.md", "ok", ""),
		setupPart("mcp", "/Users/person/.claude.json", "ok", ""),
		setupPart("hook", "/Users/person/.claude/settings.json", "ok", ""),
	}
)

func setupShell(t *testing.T, host *setupHost) *shellFixture {
	t.Helper()
	stored := acme()
	stored.extra = host.calls()
	return newShell(t, stored)
}

func TestTheAgentGroupChangesTheDesiredPathState(t *testing.T) {
	const path = "/Users/person/.local/bin/sok"
	on := map[string]any{"part": "path", "enabled": true, "state": "missing", "reason": "absent", "file": path, "step": ""}
	off := map[string]any{"part": "path", "enabled": false, "state": "ok", "file": path, "step": ""}
	host := &setupHost{states: []setupAnswer{{parts: []map[string]any{on}}}}
	stored := acme()
	stored.extra = host.calls()
	var changed string
	stored.extra["setupChange"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		changed = string(argument)
		return map[string]any{"parts": []map[string]any{off}}, nil
	}
	f := newShell(t, stored)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "agents"})
	for _, control := range f.modal().Controls {
		if control.Name == "core.settings-tab.setup-change" {
			if control.Command == nil || control.Command.Name != "core.setup.change" ||
				!reflect.DeepEqual(control.Command.Params, map[string]any{"part": "path", "enabled": false}) {
				t.Fatalf("the path control runs %+v", control.Command)
			}
			f.run("core.setup.change", map[string]any{"part": "path", "enabled": false})
			if changed != `{"part":"path","enabled":false}` && changed != `{"enabled":false,"part":"path"}` {
				t.Fatalf("changing the PATH state sent %q", changed)
			}
			for _, after := range f.modal().Controls {
				if after.Name == "core.settings-tab.setup-change" && after.Command != nil &&
					reflect.DeepEqual(after.Command.Params, map[string]any{"part": "path", "enabled": true}) {
					f.audit()
					return
				}
			}
			t.Fatal("the disabled path has no enable action")
		}
	}
	t.Fatal("the managed path has no disable action")
}

// setupStatus is the value of core.setup.
type setupStatus struct {
	Parts []struct {
		Part, File, State, Step string
		Reason, Error           string
		Changed                 *bool
	} `json:"parts"`
	Running []string `json:"running"`
}

func (f *shellFixture) setupStatus() setupStatus {
	f.t.Helper()
	value, err := f.shell.Registry().Read("core.setup")
	if err != nil {
		f.t.Fatal(err)
	}
	text, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	var status setupStatus
	if err := json.Unmarshal(text, &status); err != nil {
		f.t.Fatal(err)
	}
	return status
}

// count returns the number of setupState calls.
func (h *setupHost) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.reads
}

// The agent group reads the parts when it is shown, draws one row per part, and the install and check buttons run the setup
// commands (docs/spec/settings.md#agents).
func TestTheAgentGroupShowsAndInstallsTheSetupParts(t *testing.T) {
	host := &setupHost{states: []setupAnswer{{parts: setupMissing}, {parts: setupInstalled}, {parts: setupInstalled}}, installs: []setupAnswer{{parts: setupInstalled}}}
	f := setupShell(t, host)
	if status := f.setupStatus(); len(status.Parts) != 0 || status.Running != nil || host.count() != 0 {
		t.Fatalf("a window that does not show the group read the parts: %+v, %d reads", status, host.count())
	}
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "agents"})
	if host.count() != 1 {
		t.Fatalf("showing the group read the parts %d times", host.count())
	}
	modal := f.modal()
	if labels, want := modal.labels("core.settings-tab.setup"), []string{
		"명령 경로설치 안 됨/Users/person/.local/bin/sok끄기",
		"스킬다름/Users/person/.claude/skills/soksak/SKILL.md",
		"MCP 등록설치 안 됨/Users/person/.claude.json",
		"훅설치 안 됨/Users/person/.claude/settings.json",
	}; !slices.Equal(labels, want) {
		t.Fatalf("the rows are %q, not %q", labels, want)
	}
	if keys := modal.keys("core.settings-tab.setup-install"); !slices.Equal(keys, []string{"setup-install"}) {
		t.Fatalf("설치 is %v", keys)
	}
	for _, control := range modal.Controls {
		if control.Name == "core.settings-tab.setup-install" && !reflect.DeepEqual(control.Command.Params, map[string]any{"parts": []any{"skill", "mcp"}}) {
			t.Fatalf("설치 runs %+v", control.Command)
		}
	}
	// The group stands at the end of the general section, under the fold of the pane, so the command of the button runs as the endpoint runs it.
	f.run("core.setup.install", map[string]any{"parts": []string{"skill", "mcp"}})
	if !slices.Equal(host.args, []string{`{"parts":["skill","mcp"]}`}) {
		t.Fatalf("설치 sent %v", host.args)
	}
	status := f.setupStatus()
	if status.Running != nil || len(status.Parts) != 4 || status.Parts[1].State != "ok" || f.has("core.settings-tab.setup-install", "") {
		t.Fatalf("after the install the status is %+v and 설치 is shown: %v", status, f.has("core.settings-tab.setup-install", ""))
	}
	// window-active and setup-changed read the parts again while the group is shown, and not after it is hidden.
	f.shell.Event("window-active", nil)
	f.settle()
	f.shell.Event("setup-changed", nil)
	f.settle()
	if host.count() != 3 {
		t.Fatalf("the events of the shown group read the parts %d times in all", host.count())
	}
	f.run("core.settings.close", map[string]any{})
	f.shell.Event("window-active", nil)
	f.shell.Event("setup-changed", nil)
	f.settle()
	if host.count() != 3 {
		t.Fatalf("the events of a hidden group read the parts")
	}
	f.audit()
}

// A failed read or install is shown through the error display and keeps the parts; the error of a part goes through the same path;
// core.setup.install refuses another list than skill and mcp without repetition.
func TestTheSetupFailuresAreShownAndKeepTheParts(t *testing.T) {
	host := &setupHost{
		states: []setupAnswer{
			{parts: setupMissing},
			{err: errors.New("login shell /bin/zsh: no environment within 10 s")},
			{parts: []map[string]any{{"part": "skill", "file": "/Users/person/.claude/skills/soksak/SKILL.md", "state": "error", "step": setupSok + " skill install",
				"error": "read /Users/person/.claude/skills/soksak/SKILL.md: permission denied"}}},
			{parts: []map[string]any{}},
		},
		installs: []setupAnswer{{err: errors.New("the first sok on PATH, /usr/local/bin/sok, is not the sok of an application bundle")}},
	}
	f := setupShell(t, host)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "agents"})
	for _, parts := range []any{[]string{}, []string{"path"}, []string{"skill", "skill"}, "skill", nil, []string{"mcp", "other"}} {
		var refused *workbench.Refusal
		if err := f.finish("core.setup.install", map[string]any{"parts": parts}); !errors.As(err, &refused) || refused.Code != workbench.InvalidParams {
			t.Errorf("core.setup.install %v answered %#v", parts, err)
		}
	}
	if len(host.args) != 0 {
		t.Fatalf("a refused install reached the host: %v", host.args)
	}
	var failure error
	f.shell.Registry().RunLater("core.setup.check", json.RawMessage(`{}`), func(_ any, err error) { failure = err })
	if errors := f.shownErrors(); failure == nil || !slices.Equal(errors, []string{"setup: login shell /bin/zsh: no environment within 10 s"}) {
		t.Fatalf("the failed read answered %v and showed %q", failure, errors)
	}
	if status := f.setupStatus(); len(status.Parts) != 4 {
		t.Fatalf("a failed read replaced the parts: %+v", status)
	}
	f.shell.Registry().RunLater("core.setup.install", json.RawMessage(`{"parts":["mcp"]}`), func(_ any, err error) { failure = err })
	if errors := f.shownErrors(); failure == nil || !slices.Equal(errors, []string{"setup: the first sok on PATH, /usr/local/bin/sok, is not the sok of an application bundle"}) {
		t.Fatalf("the failed install answered %v and showed %q", failure, errors)
	}
	if status := f.setupStatus(); len(status.Parts) != 4 || status.Running != nil {
		t.Fatalf("a failed install changed the parts: %+v", status)
	}
	f.shell.Registry().RunLater("core.setup.check", json.RawMessage(`{}`), func(_ any, err error) { failure = err })
	if records := f.shownRecords(); failure != nil || len(records) != 1 || records[0].where != "setup:skill:/Users/person/.claude/skills/soksak/SKILL.md" ||
		records[0].text != "read /Users/person/.claude/skills/soksak/SKILL.md: permission denied" {
		t.Fatalf("the error of a part answered %v and recorded %+v", failure, records)
	}
	f.run("core.settings.close", map[string]any{})
	f.click("core.chrome.settings", "")
	if modal := f.modal(); len(modal.labels("core.settings-tab.setup")) != 0 || f.has("core.settings-tab.setup-install", "") || !f.has("core.settings-tab.setup-check", "") {
		t.Fatalf("a machine without parts shows %v", modal.labels("core.settings-tab.setup"))
	}
	if !slices.Contains(f.tester.Texts(), "이 컴퓨터에서 설정할 에이전트 항목이 없습니다.") {
		t.Fatalf("a machine without parts does not say so: %q", f.tester.Texts())
	}
}
