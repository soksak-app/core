//go:build diagnostics

package host_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: diagnostics.test-mark.params-validate
func TestATestMarkAcceptsOnlyAStartOrAnEndWithItsResult(t *testing.T) {
	good := map[string]host.TestMark{
		`{"window":"w","kind":"start","name":"n","run":"r"}`:               {Kind: "start", Name: "n", Run: "r"},
		`{"window":"w","kind":"end","name":"n","run":"r","result":"pass"}`: {Kind: "end", Name: "n", Run: "r", Result: "pass"},
		`{"window":"w","kind":"end","name":"n","run":"r","result":"skip"}`: {Kind: "end", Name: "n", Run: "r", Result: "skip"},
	}
	for raw, want := range good {
		got, err := host.ParseTestMark(json.RawMessage(raw))
		if err != nil || got != want {
			t.Fatalf("%s: got %+v, %v; want %+v", raw, got, err, want)
		}
	}
	bad := map[string]string{
		`{"window":"w","name":"n","run":"r"}`:                                "kind must be start or end",
		`{"window":"w","kind":"stop","name":"n","run":"r"}`:                  "kind must be start or end",
		`{"window":"w","kind":"start","name":"","run":"r"}`:                  "name must be a non-empty string",
		`{"window":"w","kind":"start","name":7,"run":"r"}`:                   "name must be a non-empty string",
		`{"window":"w","kind":"start","name":"n"}`:                           "run must be a non-empty string",
		`{"window":"w","kind":"end","name":"n","run":"r"}`:                   "result must be pass, fail or skip",
		`{"window":"w","kind":"end","name":"n","run":"r","result":"PASS"}`:   "result must be pass, fail or skip",
		`{"window":"w","kind":"start","name":"n","run":"r","result":"pass"}`: "result is only for an end mark",
	}
	for raw, message := range bad {
		_, err := host.ParseTestMark(json.RawMessage(raw))
		var rpc *host.RPCError
		if !errors.As(err, &rpc) || rpc.Code != -32602 || rpc.Message != message {
			t.Fatalf("%s: got %v, want invalid params %q", raw, err, message)
		}
	}
}

// contract: diagnostics.test-mark.event-carries-position
func TestATestMarkIsAnEventAndTheReplyNamesItsPosition(t *testing.T) {
	log := useEventLog(t)
	boot, start, err := host.EmitTestMark(host.TestMark{Kind: "start", Name: "n", Run: "r"}, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	boot2, end, err := host.EmitTestMark(host.TestMark{Kind: "end", Name: "n", Run: "r", Result: "fail"}, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if boot != "b1" || boot2 != "b1" || end != start+1 {
		t.Fatalf("positions (%s, %d) and (%s, %d)", boot, start, boot2, end)
	}
	events := readEventLog(t, log.Path())
	for _, c := range []struct {
		seq    uint64
		event  string
		fields map[string]any
	}{
		{start, "host.test.start", map[string]any{"name": "n", "run": "r"}},
		{end, "host.test.end", map[string]any{"name": "n", "run": "r", "result": "fail"}},
	} {
		event := events[c.seq-1]
		fields, _ := json.Marshal(event["fields"])
		want, _ := json.Marshal(c.fields)
		if uint64(event["seq"].(float64)) != c.seq || event["event"] != c.event || event["layer"] != "host" || event["level"] != "info" || string(fields) != string(want) {
			t.Fatalf("seq %d is %v, want %s %s", c.seq, event, c.event, want)
		}
	}
}

// contract: diagnostics.test-mark.needs-the-event-log
func TestATestMarkWithoutAnEventLogIsAnError(t *testing.T) {
	host.UseHostEventLog(nil)
	if _, _, err := host.EmitTestMark(host.TestMark{Kind: "start", Name: "n", Run: "r"}, time.Second); err == nil || err.Error() != "the event log of the host is not attached" {
		t.Fatalf("error %v", err)
	}
}
