package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The accounts of a plugin and the group Accounts of its settings page (docs/spec/plugins.md#accounts), as
// packages/workbench/test/accounts.test.mjs and settings-accounts.test.mjs check them for the web workbench.

const accountsFolder = "/Users/person/Library/Application Support/soksak/plugin-data/agents/accounts"

const accountsDocument = `{"plugins":[
	{"id":"agents","package":"agents","version":"1.0.0","folder": "/installed/plugin", "manifest":{"id":"agents","name":"에이전트","description":"에이전트 정의.",
		"sections":[{"id":"agents.list","name":"목록","composition":{"kind":"view","page":"l.html"},"height":"fill"}],
		"programs":{"account-status":{"program":"plugin:bin/account.mjs","args":[{"pattern":"[a-z]+"},{"pattern":"/.+"}]},
			"account-login":{"program":"plugin:bin/account.mjs","args":[{"pattern":"[a-z]+"},{"pattern":"/.+"}]},
			"account-logout":{"program":"plugin:bin/account.mjs","args":[{"pattern":"[a-z]+"},{"pattern":"/.+"}]}},
		"data":{"accounts":{"schema":{"type":"array"},"default":[],"scope":"plugin"}},
		"accounts":{"kinds":[{"value":"claude","label":"Claude Code"},{"value":"codex","label":"Codex"}],
			"programs":{"status":"account-status","login":"account-login","logout":"account-logout"}}}}]}`

// accountsHost answers the account calls of a test: each accountRun takes the next of runs, and a run whose reply is held waits
// until accountRunCancel of its run.
type accountsHost struct {
	mu        sync.Mutex
	names     []string
	runs      []accountAnswer
	sent      []map[string]any
	homes     []string
	cancel    chan struct{}
	cancelled []string
	removed   []string
}

// accountAnswer is the reply of a run: its exit code, output and error output, or held for a run that ends only by its cancel.
type accountAnswer struct {
	code           int
	stdout, stderr string
	held           bool
}

func (h *accountsHost) calls() map[string]workbench.HostCall {
	return map[string]workbench.HostCall{
		"accountHomes": func(context.Context, json.RawMessage) (any, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			return map[string]any{"folder": accountsFolder, "names": h.names}, nil
		},
		"accountHomeCreate": func(_ context.Context, argument json.RawMessage) (any, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.homes = append(h.homes, string(argument))
			return nil, nil
		},
		"accountHomeRemove": func(_ context.Context, argument json.RawMessage) (any, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.removed = append(h.removed, string(argument))
			return nil, nil
		},
		"accountRun": func(_ context.Context, argument json.RawMessage) (any, error) {
			h.mu.Lock()
			var request map[string]any
			if err := json.Unmarshal(argument, &request); err != nil {
				h.mu.Unlock()
				return nil, err
			}
			h.sent = append(h.sent, request)
			if len(h.runs) == 0 {
				h.mu.Unlock()
				return nil, errors.New("the test has no answer of accountRun")
			}
			answer := h.runs[0]
			h.runs = h.runs[1:]
			cancel := h.cancel
			h.mu.Unlock()
			if answer.held {
				<-cancel
				return nil, nil
			}
			return map[string]any{"code": answer.code, "stdout": answer.stdout, "stderr": answer.stderr,
				"truncated": map[string]any{"stdout": false, "stderr": false}}, nil
		},
		"accountRunCancel": func(_ context.Context, argument json.RawMessage) (any, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.cancelled = append(h.cancelled, string(argument))
			close(h.cancel)
			return nil, nil
		},
	}
}

const (
	loggedIn  = `{"login":true,"until":"2026-12-01T09:00:00+09:00","usage":[{"label":"5시간","used":42,"resets":"2026-11-26T15:00:00+09:00"}]}`
	loggedOut = `{"login":false,"until":null,"usage":[]}`
)

func accountsShell(t *testing.T, host *accountsHost, records []map[string]any) *shellFixture {
	t.Helper()
	stored := acme()
	stored.installed = accountsDocument
	stored.extra = host.calls()
	stored.pluginData = map[string]map[string]any{"agents": {"accounts": map[string]any{"format": 1, "value": records}}}
	return newShell(t, stored)
}

// accountsStatus is the value of core.accounts.
type accountsStatus struct {
	Plugin   string `json:"plugin"`
	Accounts []struct {
		ID, Name, Kind string
		Login          *bool
		Until          *string
		Usage          []map[string]any
		Running        bool
	} `json:"accounts"`
}

func (f *shellFixture) accounts() *accountsStatus {
	f.t.Helper()
	text := f.status("core.accounts")
	var status *accountsStatus
	if err := json.Unmarshal([]byte(text), &status); err != nil {
		f.t.Fatal(err)
	}
	return status
}

// accountControl is a control of the settings card as core.settings-tab reports it.
type accountControl struct {
	Label   string
	Value   *string
	Command *struct {
		Name   string
		Params map[string]any
	}
}

func (f *shellFixture) control(name string) []accountControl {
	var found []accountControl
	for _, control := range f.modal().Controls {
		if control.Name == name {
			item := accountControl{Label: control.Label, Value: control.Value}
			if control.Command != nil {
				item.Command = &struct {
					Name   string
					Params map[string]any
				}{control.Command.Name, control.Command.Params}
			}
			found = append(found, item)
		}
	}
	return found
}

func TestThePluginPageReadsTheAccountsAndDrawsTheirRows(t *testing.T) {
	host := &accountsHost{runs: []accountAnswer{{stdout: loggedIn}, {code: 1, stderr: "codex: command not found\n"}, {stdout: "not json"}, {stdout: loggedOut}}}
	f := accountsShell(t, host, []map[string]any{{"id": "account-1", "name": "업무", "kind": "claude"}, {"id": "account-2", "name": "개인", "kind": "codex"}})
	if f.status("core.accounts") != "null" {
		t.Fatalf("core.accounts before a page shows: %s", f.status("core.accounts"))
	}
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.shell.Registry().RunLater("core.settings-tab.plugin", json.RawMessage(`{"plugin":"agents"}`), func(any, error) {})
	if records := f.shownRecords(); len(records) != 1 || records[0] != (shownRecord{"settings agents", "account 개인: account-status exited with 1: codex: command not found"}) {
		t.Fatalf("the failed status run shows %+v", records)
	}
	f.settle()
	if len(host.sent) != 2 || host.sent[0]["name"] != "account-status" ||
		!reflect.DeepEqual(host.sent[0]["args"], []any{"claude", accountsFolder + "/account-1"}) || host.sent[0]["run"] != float64(1) {
		t.Fatalf("the page sent %v", host.sent)
	}
	status := f.accounts()
	if status.Plugin != "agents" || len(status.Accounts) != 2 || status.Accounts[0].Name != "개인" || status.Accounts[0].Login != nil ||
		status.Accounts[1].Name != "업무" || status.Accounts[1].Login == nil || !*status.Accounts[1].Login {
		t.Fatalf("core.accounts %+v", status)
	}
	rows := f.control("core.settings-tab.account")
	if len(rows) != 2 || rows[1].Label != "업무 · Claude Code · 로그인됨 · 2026-12-01T09:00:00+09:00까지5시간 42% · 2026-11-26T15:00:00+09:00 초기화로그아웃이름 변경삭제" ||
		rows[0].Label != "개인 · Codex · -이름 변경삭제" {
		t.Fatalf("rows %q", []string{rows[0].Label, rows[1].Label})
	}
	if logout := f.control("core.settings-tab.account-logout"); len(logout) != 1 ||
		!reflect.DeepEqual(logout[0].Command.Params, map[string]any{"plugin": "agents", "id": "account-1"}) {
		t.Fatalf("logout %+v", logout)
	}
	if add := f.control("core.settings-tab.account-add"); len(add) != 1 ||
		!reflect.DeepEqual(add[0].Command.Params, map[string]any{"plugin": "agents", "name": "", "kind": "claude"}) {
		t.Fatalf("add %+v", add)
	}
	f.run("core.settings-tab.account-name", map[string]any{"name": "새 업무"})
	f.run("core.settings-tab.account-kind", map[string]any{"kind": "codex"})
	if add := f.control("core.settings-tab.account-add"); !reflect.DeepEqual(add[0].Command.Params, map[string]any{"plugin": "agents", "name": "새 업무", "kind": "codex"}) {
		t.Fatalf("add after the fields %+v", add[0].Command.Params)
	}
	if err := f.finish("core.settings-tab.account-kind", map[string]any{"kind": "gemini"}); err == nil || !strings.Contains(err.Error(), "account kind gemini is not declared by agents") {
		t.Fatalf("an undeclared kind answered %v", err)
	}
	f.run("core.settings-tab.account-edit", map[string]any{"id": "account-1"})
	if field := f.control("core.settings-tab.account-edit-name"); len(field) != 1 || *field[0].Value != "업무" {
		t.Fatalf("the edit field %+v", field)
	}
	f.run("core.settings-tab.account-edit-name", map[string]any{"name": "회사"})
	if save := f.control("core.settings-tab.account-save"); len(save) != 1 ||
		!reflect.DeepEqual(save[0].Command.Params, map[string]any{"plugin": "agents", "id": "account-1", "name": "회사"}) {
		t.Fatalf("save %+v", save)
	}
	f.run("core.settings-tab.account-edit", map[string]any{"id": nil})
	if len(f.control("core.settings-tab.account-save")) != 0 {
		t.Fatal("the edit did not end")
	}
	f.audit()

	f.shell.Event("window-active", nil)
	if records := f.shownRecords(); len(records) != 1 || records[0] != (shownRecord{"settings agents", "account 업무: account-status printed no JSON"}) {
		t.Fatalf("the second failed status run shows %+v", records)
	}
	f.settle()
	if status := f.accounts(); status.Accounts[0].Login == nil || *status.Accounts[0].Login || !*status.Accounts[1].Login {
		t.Fatalf("core.accounts after window-active %+v", status)
	}
	f.run("core.settings-tab.plugin", map[string]any{"plugin": nil})
	if f.status("core.accounts") != "null" {
		t.Fatal("core.accounts of the plugin list")
	}
	if err := f.finish("core.settings-tab.account-name", map[string]any{"name": "a"}); err == nil || !strings.Contains(err.Error(), "no page of a plugin with accounts shows") {
		t.Fatalf("a field command of the list answered %v", err)
	}
}

func TestAnAccountIsAddedLoggedInCancelledLoggedOutAndRemoved(t *testing.T) {
	host := &accountsHost{names: []string{"account-1"}, cancel: make(chan struct{}),
		runs: []accountAnswer{{stdout: loggedOut}, {stdout: loggedOut}, {held: true}, {}, {stdout: loggedIn}, {}, {stdout: loggedOut}}}
	f := accountsShell(t, host, []map[string]any{})
	if answer := f.answerText("core.accounts.add", map[string]any{"plugin": "agents", "name": "업무", "kind": "claude"}); answer != `{"id":"account-2"}` {
		t.Fatalf("add answered %s", answer)
	}
	if !slices.Equal(host.homes, []string{`{"id":"account-2","plugin":"agents"}`}) {
		t.Fatalf("homes %q", host.homes)
	}
	stored := f.host.pluginData["agents"]["accounts"]
	encoded, err := json.Marshal(stored)
	if err != nil {
		t.Fatal(err)
	}
	var got any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"format": float64(1), "value": []any{map[string]any{"id": "account-2", "name": "업무", "kind": "claude"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stored %s", encoded)
	}

	// The page shows the status of the account, which its showing reads again.
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.run("core.settings-tab.plugin", map[string]any{"plugin": "agents"})
	// The login holds its run until its cancel, so the steps below run without settling the pending calls.
	var login error
	answered := false
	f.shell.Registry().RunLater("core.accounts.login", json.RawMessage(`{"plugin":"agents","id":"account-2"}`), func(_ any, err error) { answered, login = true, err })
	for _, name := range []string{"core.accounts.login", "core.accounts.logout", "core.accounts.remove"} {
		var refused error
		f.shell.Registry().RunLater(name, json.RawMessage(`{"plugin":"agents","id":"account-2"}`), func(_ any, err error) { refused = err })
		if refused == nil || refused.Error() != "the login of account 업무 is running" {
			t.Fatalf("%s while the login runs answered %v", name, refused)
		}
	}
	if answered {
		t.Fatal("the login answered before it ended")
	}
	// A frame drawn while the login runs shows its Cancel button; the frame does not wait for the pending calls.
	f.tester.Frame()
	if _, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.account-login-cancel", ""); !ok {
		t.Fatal("the running login has no 취소 button")
	}
	if cancel := f.control("core.settings-tab.account-login-cancel"); len(cancel) != 1 ||
		!reflect.DeepEqual(cancel[0].Command.Params, map[string]any{"plugin": "agents", "id": "account-2"}) {
		t.Fatalf("cancel %+v", cancel)
	}
	f.shell.Registry().RunLater("core.accounts.login-cancel", json.RawMessage(`{"plugin":"agents","id":"account-2"}`), func(any, error) {})
	f.settle()
	if !answered || login != nil {
		t.Fatalf("the cancelled login answered %v, %v", answered, login)
	}
	// The add and the page read the status of the account in runs 1 and 2, so the login is run 3.
	if !slices.Equal(host.cancelled, []string{`{"plugin":"agents","run":3}`}) {
		t.Fatalf("cancelled %q", host.cancelled)
	}
	f.run("core.accounts.login", map[string]any{"plugin": "agents", "id": "account-2"})
	f.settle()
	if status := f.accounts(); status.Accounts[0].Login == nil || !*status.Accounts[0].Login {
		t.Fatalf("the finished login read no status: %+v", status)
	}
	f.run("core.accounts.logout", map[string]any{"plugin": "agents", "id": "account-2"})
	f.settle()
	if status := f.accounts(); status.Accounts[0].Login == nil || *status.Accounts[0].Login {
		t.Fatalf("the logout read no status: %+v", status)
	}
	f.run("core.accounts.remove", map[string]any{"plugin": "agents", "id": "account-2"})
	if !slices.Equal(host.removed, []string{`{"id":"account-2","plugin":"agents"}`}) {
		t.Fatalf("removed %q", host.removed)
	}
	if len(host.runs) != 0 {
		t.Fatalf("%d runs were not sent", len(host.runs))
	}
}

func TestTheAccountCommandsRefuseWhatTheContractRefuses(t *testing.T) {
	host := &accountsHost{}
	f := accountsShell(t, host, []map[string]any{{"id": "account-1", "name": "업무", "kind": "claude"}})
	for _, refusal := range []struct {
		name   string
		params map[string]any
		text   string
	}{
		{"core.accounts.add", map[string]any{"plugin": "acme", "name": "a", "kind": "claude"}, "plugin acme declares no accounts"},
		{"core.accounts.add", map[string]any{"plugin": "agents", "name": "", "kind": "claude"}, "account name must be 1 to 40 characters without a control character"},
		{"core.accounts.add", map[string]any{"plugin": "agents", "name": strings.Repeat("가", 41), "kind": "claude"}, "account name must be 1 to 40 characters without a control character"},
		{"core.accounts.add", map[string]any{"plugin": "agents", "name": "a\nb", "kind": "claude"}, "account name must be 1 to 40 characters without a control character"},
		{"core.accounts.add", map[string]any{"plugin": "agents", "name": "업무", "kind": "claude"}, "account name 업무 is already used"},
		{"core.accounts.add", map[string]any{"plugin": "agents", "name": "a", "kind": "gemini"}, "account kind gemini is not declared by agents"},
		{"core.accounts.rename", map[string]any{"plugin": "agents", "id": "account-9", "name": "a"}, "account account-9 is not defined"},
		{"core.accounts.remove", map[string]any{"plugin": "agents", "id": "account-9"}, "account account-9 is not defined"},
		{"core.accounts.login-cancel", map[string]any{"plugin": "agents", "id": "account-1"}, "no login of account 업무 is running"},
	} {
		if err := f.finish(refusal.name, refusal.params); err == nil || err.Error() != refusal.text {
			t.Errorf("%s %v answered %v, want %s", refusal.name, refusal.params, err, refusal.text)
		}
	}
	for _, records := range []struct {
		value  any
		reason string
	}{
		{[]any{map[string]any{"id": "account-1", "name": "a"}}, "record 0 must be {id, name, kind}"},
		{[]any{map[string]any{"id": "Account", "name": "a", "kind": "claude"}}, `record 0 id "Account" is not an account identifier`},
		{[]any{map[string]any{"id": "account-1", "name": "", "kind": "claude"}}, "record 0 name must be 1 to 40 characters without a control character"},
		{[]any{map[string]any{"id": "account-1", "name": "a", "kind": "gemini"}}, `record 0 kind "gemini" is not declared`},
		{[]any{map[string]any{"id": "account-1", "name": "a", "kind": "claude"}, map[string]any{"id": "account-1", "name": "b", "kind": "claude"}}, "id account-1 repeats"},
		{[]any{map[string]any{"id": "account-1", "name": "a", "kind": "claude"}, map[string]any{"id": "account-2", "name": "a", "kind": "codex"}}, "name a repeats"},
	} {
		f.host.pluginData["agents"]["accounts"] = map[string]any{"format": 1, "value": records.value}
		f.shell.Event("workspace-changed", nil)
		f.settle()
		if err := f.finish("core.accounts.rename", map[string]any{"plugin": "agents", "id": "account-1", "name": "x"}); err == nil || err.Error() != "plugin agents data accounts: "+records.reason {
			t.Errorf("records %v answered %v", records.value, err)
		}
	}
	if len(host.sent) != 0 {
		t.Fatalf("a refusal sent %v", host.sent)
	}
}
