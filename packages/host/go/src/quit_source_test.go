// The record of an exit request names where the quit came from: an Apple event with its sender, a signal with its sender, a quit
// of the host itself with its request, or the menu or a key with the type of the current event.
package host

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// startQuitSourceWriter makes a writer that stores every level the writer of the records of the host until the test ends.
func startQuitSourceWriter(t *testing.T, config string) *EventLog {
	t.Helper()
	log, err := StartHostEventLog(config)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := ParseLogPolicy("quit source test policy", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`))
	if err != nil {
		log.Close()
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
	UseHostEventLog(log)
	t.Cleanup(func() {
		UseHostEventLog(nil)
		log.Close()
	})
	return log
}

// quitSourceEvents are the events of the host logs of config.
func quitSourceEvents(t *testing.T, config string) []map[string]any {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(config, "logs", "host-*.jsonl"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("host event logs %v, %v", paths, err)
	}
	var events []map[string]any
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
			var event map[string]any
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				t.Fatalf("event log %s holds a line that is not JSON: %v", path, err)
			}
			events = append(events, event)
		}
	}
	return events
}

// noMenu is the event type that a test reads when a quit names no source: a test fails when it asks for it.
func noMenu(t *testing.T) func() int {
	return func() int {
		t.Error("the exit request read the current event although its quit named a source")
		return -1
	}
}

// contract: log.closed.exit-request-source
func TestTheExitRequestNamesTheSourceOfItsQuit(t *testing.T) {
	config := t.TempDir()
	log := startQuitSourceWriter(t, config)
	QuitWithCause("quit-request", AppleEventQuitSource(77, "com.apple.dt.Xcode"), func() { EmitExitRequest(noMenu(t)) })
	QuitWithCause("update", HostQuitSource("update"), func() { EmitExitRequest(noMenu(t)) })
	var state Quit
	QuitFromSignal(&state, 15, 88, func() { EmitExitRequest(noMenu(t)) })
	QuitWithCause("quit-request", AppleEventQuitSource(0, ""), func() { EmitExitRequest(noMenu(t)) })
	// A quit that no part of the host asked for is the menu or a key equivalent of the framework, named by the current event.
	EmitExitRequest(func() int { return 10 })
	EmitExitRequest(func() int { return -1 })
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	for _, event := range quitSourceEvents(t, config) {
		if fields, _ := event["fields"].(map[string]any); event["event"] == "log.closed" && fields["cause"] == "exit-request" {
			got = append(got, fields)
		}
	}
	want := []map[string]any{
		{"cause": "exit-request", "source": "apple-event", "sender_pid": float64(77), "sender": "com.apple.dt.Xcode"},
		{"cause": "exit-request", "source": "host", "request": "update"},
		{"cause": "exit-request", "source": "signal", "signal": float64(15), "sender_pid": float64(88)},
		{"cause": "exit-request", "source": "apple-event"},
		{"cause": "exit-request", "source": "menu", "event_type": float64(10)},
		{"cause": "exit-request", "source": "menu"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("exit requests = %v, want %v", got, want)
	}
	if !state.Active() {
		t.Fatal("a quit of a signal did not begin the quit state")
	}
}
