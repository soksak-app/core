package host_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// activityState is the state of the connection activity that the last native.connection.activity record of the event log of
// a configuration folder states.
type activityState struct {
	held, recorded bool
	err            error
}

// recordedActivity flushes log and reads the records of the activity from the event log of config.
func recordedActivity(log *host.EventLog, config string) activityState {
	if err := log.Flush(); err != nil {
		return activityState{err: err}
	}
	paths, err := filepath.Glob(filepath.Join(config, "logs", "host-*.jsonl"))
	if err != nil || len(paths) == 0 {
		return activityState{err: fmt.Errorf("host event logs %v, %v", paths, err)}
	}
	var events []map[string]any
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return activityState{err: err}
		}
		for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
			var event map[string]any
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				return activityState{err: fmt.Errorf("event log %s holds the line %q: %v", path, line, err)}
			}
			events = append(events, event)
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i]["seq"].(float64) < events[j]["seq"].(float64) })
	state := activityState{}
	for _, event := range events {
		if event["event"] != "native.connection.activity" {
			continue
		}
		held, ok := event["fields"].(map[string]any)["held"].(bool)
		if !ok {
			return activityState{err: fmt.Errorf("native.connection.activity without a boolean held: %v", event)}
		}
		state = activityState{held: held, recorded: true}
	}
	return state
}

// activityBackend is the window of the endpoint, which reads, at the delivery of the release of each press, the state of the
// activity that the event log records.
type activityBackend struct {
	*fakeBackend
	log    *host.EventLog
	config string
	ups    chan activityState
}

func (b *activityBackend) Pointer(window string, input host.PointerInput) error {
	if input.Phase == "up" {
		b.ups <- recordedActivity(b.log, b.config)
	}
	return b.fakeBackend.Pointer(window, input)
}

// The host holds the connection activity while a connection of its endpoint is open, so the system does not run it in the
// background while a client waits for its answers, and releases it when the last connection closes. The native library records
// each begin and end of the activity, and the end of a connection releases the activity before it releases the presses of the
// connection, so the record that the event log holds at the delivered release of a press is the state that the end left.
// contract: endpoint.connection.holds-activity
func TestTheEndpointHoldsTheActivityWhileAConnectionIsOpen(t *testing.T) {
	config := t.TempDir()
	// The record of the activity is a lifecycle event at info, which the default policy refuses; the policy file of the
	// configuration asks for it, as a person does (docs/spec/logging.md#policy).
	policy := `{"schema":1,"classes":{"lifecycle":"info","input":"error","call":"error","io":"error","frame":"error"}}`
	if err := os.WriteFile(filepath.Join(config, "log-policy.json"), []byte(policy), 0o600); err != nil {
		t.Fatal(err)
	}
	log, err := host.StartHostEventLog(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.Close)
	stopPolicy, err := host.StartLogPolicy(log, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopPolicy()
		// The native gate belongs to the process, so the next test starts with the default policy.
		system, err := platform.Current()
		if err == nil {
			err = system.SetNativeEventPolicy(host.DefaultLogPolicy().Levels())
		}
		if err != nil {
			t.Errorf("restore the default native policy: %v", err)
		}
	})
	backend := &activityBackend{fakeBackend: newFakeBackend(), log: log, config: config, ups: make(chan activityState, 4)}
	_, address, _ := serve(t, backend)
	if state := recordedActivity(log, config); state.err != nil || state.held {
		t.Fatalf("before a connection the log records the activity %+v", state)
	}
	first := dial(t, address)
	if reply := call(t, first, 1, "input.pointer", map[string]any{"window": "main", "pointer": "second", "x": 1, "y": 2,
		"phase": "down", "button": "right"}); reply.Error != nil {
		t.Fatalf("the down of the first connection: %+v", reply.Error)
	}
	second := dial(t, address)
	if reply := call(t, second, 1, "input.pointer", map[string]any{"window": "main", "pointer": "third", "x": 3, "y": 4,
		"phase": "down", "button": "right"}); reply.Error != nil {
		t.Fatalf("the down of the second connection: %+v", reply.Error)
	}
	if state := recordedActivity(log, config); state.err != nil || !state.recorded || !state.held {
		t.Fatalf("with two open connections the log records the activity %+v, want held", state)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if state := <-backend.ups; state.err != nil || !state.held {
		t.Fatalf("at the release of the press of one of two connections the log records the activity %+v, want held", state)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if state := <-backend.ups; state.err != nil || state.held {
		t.Fatalf("at the release of the press of the last connection the log records the activity %+v, want released", state)
	}
}
