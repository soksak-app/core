// The policy of the event log (docs/spec/logging.md#classes-and-policy): the file log-policy.json says for each class the least
// severe level that is stored; the gate at the producers builds nothing for an event the policy refuses and counts it.
package host_test

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

const everything = `{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`

// contract: log.policy.file-names-every-class-and-nothing-else
func TestAPolicyFileNamesEveryClassWithALevelAndNothingElse(t *testing.T) {
	policy, err := host.ParseLogPolicy("config/log-policy.json", []byte(everything))
	if err != nil {
		t.Fatal(err)
	}
	for _, class := range []host.Class{host.ClassLifecycle, host.ClassInput, host.ClassCall, host.ClassIo, host.ClassFrame} {
		for _, level := range []host.Level{host.LevelError, host.LevelWarn, host.LevelInfo, host.LevelDebug, host.LevelTrace} {
			if !policy.Allows(class, level) {
				t.Fatalf("the policy that stores everything refuses %s %s", class, level)
			}
		}
	}
	narrow, err := host.ParseLogPolicy("config/log-policy.json", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"debug","call":"info","io":"off","frame":"error"}}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []struct {
		class host.Class
		level host.Level
		ok    bool
	}{
		{host.ClassInput, host.LevelDebug, true}, {host.ClassInput, host.LevelTrace, false}, {host.ClassCall, host.LevelInfo, true},
		{host.ClassCall, host.LevelDebug, false}, {host.ClassIo, host.LevelError, false}, {host.ClassFrame, host.LevelError, true},
		{host.ClassFrame, host.LevelWarn, false}, {host.ClassLifecycle, host.LevelTrace, true},
	} {
		if got := narrow.Allows(want.class, want.level); got != want.ok {
			t.Errorf("Allows(%s, %s) = %v, want %v", want.class, want.level, got, want.ok)
		}
	}
	for text, message := range map[string]string{
		`{"schema":2,"classes":{}}`:                    `config/log-policy.json: schema 2 is not 1`,
		`{"schema":1}`:                                 `config/log-policy.json: classes must be an object that names every class`,
		`{"schema":1,"classes":{"lifecycle":"trace"}}`: `config/log-policy.json: the class input is missing`,
		`{"schema":1,"classes":{"lifecycle":"trace","input":"loud","call":"trace","io":"trace","frame":"trace"}}`:                  `config/log-policy.json: the level "loud" of the class input is not one of off, error, warn, info, debug, trace`,
		`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace","audio":"trace"}}`: `config/log-policy.json: the class audio is not one of lifecycle, input, call, io, frame`,
		`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"},"note":1}`:        `config/log-policy.json: the member note is not one of schema, classes`,
		`{broken`: `config/log-policy.json: not JSON`,
	} {
		if _, err := host.ParseLogPolicy("config/log-policy.json", []byte(text)); err == nil || !strings.Contains(err.Error(), message) {
			t.Errorf("%s: error %v, want %q", text, err, message)
		}
	}
}

func startPolicyLog(t *testing.T, policy string) *host.EventLog {
	t.Helper()
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := host.ParseLogPolicy("policy", []byte(policy))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(parsed, "file")
	return log
}

// contract: log.policy.gate-counts-what-it-did-not-build
func TestAClosedGateStoresNothingAndCountsWhatTheProducerDidNotBuild(t *testing.T) {
	log := startPolicyLog(t, `{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"info","io":"off","frame":"trace"}}`)
	if log.Enabled(host.ClassCall, host.LevelDebug) || !log.Enabled(host.ClassCall, host.LevelWarn) || log.Enabled(host.ClassIo, host.LevelError) {
		t.Fatal("Enabled does not follow the policy")
	}
	// Enabled does not count; Gate counts the event that the producer then does not build.
	for index := 0; index < 5; index++ {
		if log.Gate(host.ClassCall, host.LevelDebug) {
			t.Fatal("the gate of call at debug is open")
		}
	}
	if !log.Gate(host.ClassCall, host.LevelInfo) {
		t.Fatal("the gate of call at info is closed")
	}
	// An event that reaches the writer through a closed gate is not stored and counted too.
	for index := 0; index < 3; index++ {
		if log.Emit(host.LevelDebug, "host.binding.call", map[string]any{"name": "x", "args": "[]", "micros": 1, "ok": true, "truncated": false}) {
			t.Fatal("the writer accepted an event of a closed gate")
		}
	}
	if !log.Emit(host.LevelInfo, "host.app.event", map[string]any{"kind": "started"}) {
		t.Fatal("the writer refused an event of an open gate")
	}
	if log.Emit(host.LevelError, "host.sidecar.request", map[string]any{"name": "n", "surface": "s", "bytes": 1}) {
		t.Fatal("the writer accepted an event of the class io, which the policy turns off")
	}
	// An event of a name that the catalog does not declare has no class, so no gate refuses it.
	if !log.Emit(host.LevelDebug, "host.test.event", map[string]any{}) {
		t.Fatal("the writer refused an undeclared event")
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	counts := map[string]float64{}
	stored := 0
	for _, event := range readEventLog(t, log.Path()) {
		switch event["event"] {
		case "log.gated":
			fields := event["fields"].(map[string]any)
			counts[fmt.Sprint(fields["class"], "/", fields["level"])] += fields["count"].(float64)
			if event["class"] != "lifecycle" || event["level"] != "info" {
				t.Errorf("log.gated line: %v", event)
			}
		case "host.binding.call", "host.sidecar.request", "host.app.event":
			stored++
		}
	}
	if counts["call/debug"] != 8 || counts["io/error"] != 1 || len(counts) != 2 {
		t.Fatalf("log.gated counted %v, want 8 events of call/debug (5 gates and 3 emits) and 1 of io/error", counts)
	}
	if stored != 1 {
		t.Fatalf("%d gated events were stored", stored)
	}
}

// contract: log.policy.change-is-an-event
func TestAPolicyChangeIsAnEventAndTheSamePolicyIsNot(t *testing.T) {
	log := startPolicyLog(t, everything)
	narrow, err := host.ParseLogPolicy("policy", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"info","io":"trace","frame":"trace"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(narrow, "file")
	log.SetPolicy(narrow, "file")
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var changes []map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "log.policy" {
			changes = append(changes, event)
		}
	}
	if len(changes) != 2 {
		t.Fatalf("%d log.policy events, want one for the first policy and one for the change: %v", len(changes), changes)
	}
	last := changes[1]["fields"].(map[string]any)
	classes := last["classes"].(map[string]any)
	if last["source"] != "file" || classes["call"] != "info" || classes["lifecycle"] != "trace" || len(classes) != 5 || changes[1]["class"] != "lifecycle" {
		t.Fatalf("the change: %v", changes[1])
	}
}

// contract: log.policy.gate-passes-the-events-of-the-writer-itself
func TestTheEventsOfTheWriterItselfPassAGateThatTurnsTheLifecycleOff(t *testing.T) {
	log := startPolicyLog(t, `{"schema":1,"classes":{"lifecycle":"off","input":"trace","call":"off","io":"trace","frame":"trace"}}`)
	log.Gate(host.ClassCall, host.LevelDebug)
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, event := range readEventLog(t, log.Path()) {
		names[event["event"].(string)] = true
	}
	if !names["log.open"] || !names["log.policy"] || !names["log.gated"] {
		t.Fatalf("the writer stored %v although the policy turns the class lifecycle off", names)
	}
}

// contract: log.policy.file-is-watched
func TestThePolicyFileIsWatchedAndEveryChangeIsAppliedOnce(t *testing.T) {
	config := t.TempDir()
	options := eventLogOptions(filepath.Join(config, "logs"))
	options.PolicyPath = filepath.Join(config, "log-policy.json")
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	applied := make(chan [2]string, 16)
	stop, err := host.StartLogPolicy(log, func(source, detail string) { applied <- [2]string{source, detail} })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(stop)
	// The step names the change that the check made, so a failure states which change gave which source and detail.
	wait := func(step, want string) {
		t.Helper()
		select {
		case got := <-applied:
			if got[0] != want {
				t.Fatalf("%s: applied %q (%s), want %q", step, got[0], got[1], want)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("%s: the policy %q was not applied within 10 seconds", step, want)
		}
	}
	// The file does not exist: the policy that stores everything is in force, from the default.
	wait("start without a file", "default")
	if !log.Enabled(host.ClassCall, host.LevelTrace) {
		t.Fatal("the default policy does not store everything")
	}
	narrow := `{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"info","io":"trace","frame":"trace"}}`
	// An atomic replacement (a new file renamed over the path) is applied.
	temporary := filepath.Join(config, ".log-policy.tmp")
	if err := os.WriteFile(temporary, []byte(narrow), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, options.PolicyPath); err != nil {
		t.Fatal(err)
	}
	wait("atomic replacement", "file")
	if log.Enabled(host.ClassCall, host.LevelDebug) {
		t.Fatal("the policy of the file is not in force")
	}
	// A write in place is applied too.
	if err := os.WriteFile(options.PolicyPath, []byte(everything), 0o600); err != nil {
		t.Fatal(err)
	}
	wait("write in place", "file")
	if !log.Enabled(host.ClassCall, host.LevelDebug) {
		t.Fatal("the written policy is not in force")
	}
	// A file that breaks the format is an error record that names the file, and the policy in force stays.
	if err := os.WriteFile(options.PolicyPath, []byte(`{"schema":9}`), 0o600); err != nil {
		t.Fatal(err)
	}
	wait("refused file", "error")
	if !log.Enabled(host.ClassCall, host.LevelDebug) {
		t.Fatal("a broken file changed the policy")
	}
	// The removal of the file returns to the default policy.
	if err := os.Remove(options.PolicyPath); err != nil {
		t.Fatal(err)
	}
	wait("removal", "default")
}

// contract: log.policy.page-sets-the-file
func TestThePageSetsThePolicyThroughTheLogCallAndTheHostWritesTheFile(t *testing.T) {
	config := t.TempDir()
	options := eventLogOptions(filepath.Join(config, "logs"))
	options.PolicyPath = filepath.Join(config, "log-policy.json")
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"action": "policy", "classes": map[string]any{"lifecycle": "trace", "input": "trace", "call": "warn", "io": "trace", "frame": "off"}}
	if _, err := host.LogCommand(log, request); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(options.PolicyPath)
	if err != nil {
		t.Fatal(err)
	}
	written, err := host.ParseLogPolicy(options.PolicyPath, data)
	if err != nil {
		t.Fatal(err)
	}
	if written.Allows(host.ClassCall, host.LevelInfo) || !written.Allows(host.ClassCall, host.LevelWarn) || written.Allows(host.ClassFrame, host.LevelError) {
		t.Fatalf("the file holds %s", data)
	}
	info, err := os.Stat(options.PolicyPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the policy file: %v, %v", info, err)
	}
	// A request that names a class twice, a class that does not exist or a level outside the contract is refused and writes nothing.
	for name, bad := range map[string]map[string]any{
		"a missing class":          {"lifecycle": "trace"},
		"an unknown class":         {"lifecycle": "trace", "input": "trace", "call": "trace", "io": "trace", "frame": "trace", "audio": "trace"},
		"an unknown level":         {"lifecycle": "trace", "input": "loud", "call": "trace", "io": "trace", "frame": "trace"},
		"a level that is not text": {"lifecycle": 4, "input": "trace", "call": "trace", "io": "trace", "frame": "trace"},
	} {
		if err := os.Remove(options.PolicyPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		if _, err := host.LogCommand(log, map[string]any{"action": "policy", "classes": bad}); err == nil {
			t.Errorf("%s was accepted", name)
		}
		if _, err := os.Stat(options.PolicyPath); err == nil {
			t.Errorf("%s wrote the file", name)
		}
	}
	bare, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.LogCommand(bare, request); err == nil || !strings.Contains(err.Error(), "policy file") {
		t.Fatalf("a writer without a policy file: %v", err)
	}
}
