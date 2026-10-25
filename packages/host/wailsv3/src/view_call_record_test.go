//go:build diagnostics

package host

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
	"unsafe"
)

const viewRecordChild = "SOKSAK_VIEW_RECORD_CHILD"

// contract: view.call.record
// The host records a call request of a view and its reply at the debug level, with the plugin, the surface and the id, so a call
// without its reply record is unanswered (docs/spec/native-surfaces.md#view-surfaces).
func TestViewCallAndReplyAreRecordedAtDebugWithTheirIdentifier(t *testing.T) {
	if config := os.Getenv(viewRecordChild); config != "" {
		log := startViewRecordWriter(t, config)
		s := registeredViewRecordSurfaces(t)
		if err := s.ViewMessage("probe-surface", `{"message":{"sok":1,"id":7,"command":"probe.run","params":{"a":1}}}`); err != nil {
			t.Fatalf("view call: %v", err)
		}
		if err := s.ViewMessage("probe-surface", `{"message":{"sok":1,"reply":7,"result":{"ok":true}}}`); err != nil {
			t.Fatalf("view reply: %v", err)
		}
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		return
	}
	config := t.TempDir()
	runViewRecordChild(t, config, "TestViewCallAndReplyAreRecordedAtDebugWithTheirIdentifier")
	var calls, replies []map[string]any
	for _, event := range viewRecordEvents(t, config) {
		switch event["event"] {
		case "host.view.call":
			calls = append(calls, event)
		case "host.view.reply":
			replies = append(replies, event)
		}
	}
	if len(calls) != 1 || calls[0]["level"] != "debug" || calls[0]["fields"].(map[string]any)["command"] != "probe.run" ||
		calls[0]["fields"].(map[string]any)["id"] != float64(7) || calls[0]["fields"].(map[string]any)["plugin"] != "probe" {
		t.Fatalf("host.view.call records: %v, want exactly one debug record of plugin probe, id 7 and command probe.run", calls)
	}
	if len(replies) != 1 || replies[0]["level"] != "debug" || replies[0]["fields"].(map[string]any)["outcome"] != "result" ||
		replies[0]["fields"].(map[string]any)["id"] != float64(7) {
		t.Fatalf("host.view.reply records: %v, want exactly one debug record of id 7 with outcome result", replies)
	}
}

func startViewRecordWriter(t *testing.T, config string) *EventLog {
	t.Helper()
	log, err := StartHostEventLog(config)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := ParseLogPolicy("view record test policy", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`))
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

func registeredViewRecordSurfaces(t *testing.T) *Surfaces {
	t.Helper()
	s := &Surfaces{
		documents:     NewDocuments(),
		sourceOrigins: newSourceOrigins(),
		views:         map[string]*nativeWebview{},
		events:        func(string, any) {},
	}
	generation, err := s.sourceOriginState().create("probe-surface", true)
	if err != nil {
		t.Fatal(err)
	}
	if current, ok := s.sourceOriginState().current("probe-surface", true); !ok || current != generation {
		t.Fatalf("registered view origin is not current: generation %d, current %d, present %t", generation, current, ok)
	}
	handle := unsafe.Pointer(new(int))
	s.documents.registerView("probe-surface", "probe", generation, handle)
	s.views["probe-surface"] = &nativeWebview{handle: handle}
	return s
}

func runViewRecordChild(t *testing.T, config, name string) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run", "^"+name+"$", "-test.count=1")
	command.Env = append(os.Environ(), viewRecordChild+"="+config)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("child %s: %v: %s", name, err, output)
	}
}

func viewRecordEvents(t *testing.T, config string) []map[string]any {
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
			if line == "" {
				continue
			}
			var event map[string]any
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				t.Fatalf("event log %s contains invalid JSON: %v", path, err)
			}
			events = append(events, event)
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i]["seq"].(float64) < events[j]["seq"].(float64) })
	return events
}
