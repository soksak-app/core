package workbench_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	sok "github.com/soksak-app/core/packages/sok/go/src"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

var operationIdentifier = regexp.MustCompile(`^p[0-9a-f-]+\.[1-9][0-9]*$`)

// followCalls stores the debug events of the calls, as the setting diagnostics.log does.
func (f *shellFixture) followCalls() {
	f.t.Helper()
	classes := map[string]any{}
	for name, level := range sok.DefaultLogPolicy().Classes() {
		classes[name] = level
	}
	classes["call"] = "debug"
	f.shell.Event("log-policy", []any{map[string]any{"classes": classes}})
}

// chain returns the only event named first, whose identifier the workbench assigned, after each host call in calls carried it.
func (f *shellFixture) chain(stored *storedHost, first string, calls ...string) map[string]any {
	f.t.Helper()
	f.flush()
	starts := stored.written(first)
	if len(starts) != 1 {
		f.t.Fatalf("the host received %d events %s", len(starts), first)
	}
	cids, _ := starts[0]["cids"].([]any)
	if len(cids) != 1 || !operationIdentifier.MatchString(fmt.Sprint(cids[0])) {
		f.t.Fatalf("the identifiers of %s are %v", first, starts[0]["cids"])
	}
	for _, name := range calls {
		carried := false
		for _, event := range stored.written("workbench.call") {
			if fields := event["fields"].(map[string]any); fields["name"] == name && fmt.Sprint(event["cids"]) == fmt.Sprint(cids) {
				carried = true
			}
		}
		if !carried {
			f.t.Fatalf("no workbench.call of %s carries %v: %v", name, cids, stored.written("workbench.call"))
		}
	}
	return starts[0]["fields"].(map[string]any)
}

func TestSettingsPolicyClosesOnlyAfterItsOperationChainDrains(t *testing.T) {
	stored := recordingCommands(&storedHost{common: map[string]any{}})
	f := newShell(t, stored)
	stored.batches = nil
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"diagnostics.log": map[string]string{}}, "scope": "common"})
	fields := f.chain(stored, "workbench.settings.change", "workspace")
	if fields["actor"] != "core.settings.set" || fields["keys"] != "diagnostics.log" {
		t.Fatalf("wrong settings operation: %v", fields)
	}
	if len(stored.policies) == 0 || stored.policies[len(stored.policies)-1]["call"] != "error" {
		t.Fatalf("new requested policy was not eventually applied: %v", stored.policies)
	}
	starts := stored.written("workbench.settings.change")
	flushed := false
	for _, event := range stored.policyBatches[len(stored.policyBatches)-1] {
		if event["event"] == "workbench.call" && fmt.Sprint(event["cids"]) == fmt.Sprint(starts[0]["cids"]) {
			flushed = true
		}
	}
	if !flushed {
		t.Fatal("the new policy reached the host before the real settings completion batch drained")
	}
}

func TestQueuedSettingsWritesApplyOnlyTheLatestPolicyAfterBothCompletions(t *testing.T) {
	stored := recordingCommands(&storedHost{common: map[string]any{}})
	f := newShell(t, stored)
	stored.batches = nil
	before := len(stored.policies)
	for _, policy := range []string{`{}`, `{"call":"info"}`} {
		f.shell.Registry().RunLater("core.settings.set", json.RawMessage(`{"patch":{"diagnostics.log":`+policy+`},"scope":"common"}`), func(_ any, err error) {
			if err != nil {
				t.Error(err)
			}
		})
	}
	f.settle()
	f.flush()
	if len(stored.policies) != before+1 || stored.policies[before]["call"] != "info" {
		t.Fatalf("queued writes did not coalesce to the latest policy: %v", stored.policies[before:])
	}
	starts := stored.written("workbench.settings.change")
	if len(starts) != 2 {
		t.Fatalf("settings operation starts: %v", starts)
	}
	for _, start := range starts {
		completed := false
		for _, event := range stored.policyBatches[before] {
			if event["event"] == "workbench.call" && fmt.Sprint(event["cids"]) == fmt.Sprint(start["cids"]) {
				completed = true
			}
		}
		if !completed {
			t.Fatalf("new policy preceded completed settings call %v", start["cids"])
		}
	}
}

func TestRetiredSettingsCompletionDoesNotApplyPolicy(t *testing.T) {
	stored := recordingCommands(&storedHost{common: map[string]any{}})
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	before := len(stored.policies)
	release := make(chan struct{})
	stored.holdWorkspace = release
	app.Emit(window, "exposure-request", map[string]any{"id": 77, "method": "command.run", "params": json.RawMessage(`{"name":"core.settings.set","params":{"patch":{"diagnostics.log":{}},"scope":"common"}}`)})
	queue.drain(t)
	app.Close(window)
	close(release)
	queue.drain(t)
	if len(stored.policies) != before {
		t.Fatalf("retired settings answer applied a policy: %v", stored.policies[before:])
	}
}

// A command that changes the settings answers once the host wrote them, so a reader of the settings file after the answer finds the
// change, as the page answers after its store wrote them.
func TestASettingsCommandAnswersAfterTheWrite(t *testing.T) {
	stored := &storedHost{common: map[string]any{}}
	app, window, queue, replies := fixtureApp(t, stored)
	tester := ui.NewTester(app.Build(window), 1200, 800)
	app.Shown(window)
	window.settle(t, queue, tester)
	release := make(chan struct{})
	stored.holdWorkspace = release
	app.Emit(window, "exposure-request", map[string]any{"id": 78, "method": "command.run",
		"params": json.RawMessage(`{"name":"core.settings.set","params":{"patch":{"mode":"dark"},"scope":"common"}}`)})
	window.settle(t, queue, tester)
	answered := func() int {
		return slices.IndexFunc(*replies, func(reply map[string]any) bool { return reply["id"] == float64(78) })
	}
	if at := answered(); at >= 0 {
		t.Fatalf("core.settings.set answered %v before the host wrote the settings", (*replies)[at])
	}
	close(release)
	window.settle(t, queue, tester)
	at := answered()
	if at < 0 || (*replies)[at]["error"] != nil {
		t.Fatalf("core.settings.set did not answer after the write: the replies are %v", *replies)
	}
}

func TestAPluginOperationIsAChain(t *testing.T) {
	plugins := &pluginsHost{plugins: map[string]map[string]any{"beta": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}}}
	f := pluginShell(t, plugins, `{"plugins":[]}`)
	f.followCalls()
	if err := f.finish("core.plugins.disable", map[string]string{"plugin": "beta"}); err != nil {
		t.Fatal(err)
	}
	fields := f.chain(f.host, "workbench.plugin.operation", "pluginsRun")
	if fields["action"] != "disable" || fields["plugin"] != "beta" {
		t.Fatalf("the fields are %v", fields)
	}
}

func TestAnApplicationUpdateIsAChain(t *testing.T) {
	f, stored := updateShell(t, appRelease)
	f.followCalls()
	stored.failing = nil
	f.shell.Registry().RunLater("core.app.update", json.RawMessage(`{}`), func(any, error) {})
	f.pending.drain(t)
	f.tester.Frame()
	f.pending.drain(t)
	f.tester.Frame()
	fields := f.chain(stored, "workbench.update.operation", "appUpdateStage", "appUpdateApply")
	if fields["action"] != "update" || fields["version"] != "2.0.0" {
		t.Fatalf("the fields are %v", fields)
	}
}

func TestOpeningAndRemovingAProjectAreChains(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.followCalls()
	f.shell.Registry().RunLater("core.project.open", json.RawMessage(`{"root":"/work/alpha"}`), func(any, error) {})
	f.settle()
	fields := f.chain(f.host, "workbench.project.operation", "projectOpen")
	if fields["action"] != "open" || fields["project"] == nil {
		t.Fatalf("the fields are %v", fields)
	}
	id := fields["project"].(string)
	f.host.batches = nil
	if err := f.finish("core.project.close", map[string]string{"id": id}); err != nil {
		t.Fatal(err)
	}
	fields = f.chain(f.host, "workbench.project.operation", "projectRemoveAsk", "projectRelease")
	if fields["action"] != "remove" || fields["project"] != id {
		t.Fatalf("the fields are %v", fields)
	}
}

func TestANewWindowIsAChain(t *testing.T) {
	for _, command := range []string{"core.library.window", "core.window.new"} {
		t.Run(command, func(t *testing.T) {
			f := newShell(t, &storedHost{})
			f.followCalls()
			if err := f.finish(command, struct{}{}); err != nil {
				t.Fatal(err)
			}
			if fields := f.chain(f.host, "workbench.window.operation", "windowNew"); fields["action"] != "new" {
				t.Fatalf("the fields are %v", fields)
			}
		})
	}
}

func TestClosingAWindowStoresItsEventBeforeTheCall(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.followCalls()
	f.shell.Event("project-close-request", nil)
	f.settle()
	if fields := f.chain(f.host, "workbench.window.operation", "windowClose"); fields["action"] != "close" {
		t.Fatalf("the fields are %v", fields)
	}
}

func TestASettingsChangeIsAChain(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.followCalls()
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"textSize": 1.1}, "scope": "common"})
	f.settle()
	fields := f.chain(f.host, "workbench.settings.change", "workspace")
	if fields["scope"] != "common" || fields["actor"] != "core.settings.set" || fields["keys"] != "textSize" {
		t.Fatalf("the fields are %v", fields)
	}
}

func TestTheTextSizeCommandIsTheActorOfItsChange(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.followCalls()
	f.run("core.text.larger", nil)
	f.settle()
	if fields := f.chain(f.host, "workbench.settings.change", "workspace"); fields["actor"] != "core.text.larger" || fields["keys"] != "textSize" {
		t.Fatalf("the fields are %v", fields)
	}
}

// A host call of the workbench is the event host.binding.call of the host, as a call through the bound method of a page is.
func TestAHostCallIsAnEventOfTheHostWithItsIdentifiers(t *testing.T) {
	host.UseHostEventLog(nil)
	log, err := host.StartEventLog(host.EventLogOptions{Directory: t.TempDir(), Role: "host", Boot: "b1", QueueEvents: 64, QueueBytes: 64 * 1024,
		BatchInterval: 20 * time.Millisecond, RotateBytes: 1 << 30, RetentionBytes: 1 << 40})
	if err != nil {
		t.Fatal(err)
	}
	policy, err := host.ParseLogPolicy("calls", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
	host.UseHostEventLog(log)
	t.Cleanup(func() { host.UseHostEventLog(nil); log.Close() })
	queue := make(steps, 8)
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"pluginsRun": func(context.Context, json.RawMessage) (any, error) { return nil, nil },
	}, queue.post)
	calls.Caused([]string{"pfixture.1"}).Call("pluginsRun", map[string]string{"plugin": "beta"}, func(any, error) {})
	queue.run()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(strings.TrimSuffix(log.Path(), ".jsonl") + ".debug.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, line := range strings.Split(string(data), "\n") {
		found = found || strings.Contains(line, `"host.binding.call"`) && strings.Contains(line, `"pfixture.1"`) && strings.Contains(line, `plugins_run`)
	}
	if !found {
		t.Fatalf("the log holds %s", data)
	}
}
