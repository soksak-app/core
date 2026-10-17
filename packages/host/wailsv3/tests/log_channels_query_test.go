// The query over the files that the writer wrote (docs/spec/logging.md#query): the channel `other` reads the main file and its
// generations, the channel `debug` reads the debug file and its generations, and the filter `class` matches the class that the
// writer stored in the line.
package host_test

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// writeMixedEvents writes events of every level and of three classes through the writer into a configuration folder whose small
// bound rotates both files, and returns the folder and the number of events of each level.
func writeMixedEvents(t *testing.T) (string, map[host.Level]int) {
	t.Helper()
	config := t.TempDir()
	options := eventLogOptions(filepath.Join(config, "logs"))
	options.RotateBytes = 1500
	options.QueueEvents = 500
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	counts := map[host.Level]int{}
	events := []struct {
		level host.Level
		name  string
	}{
		{host.LevelError, "host.panic"}, {host.LevelWarn, "host.crash.found"}, {host.LevelInfo, "host.app.event"},
		{host.LevelDebug, "host.binding.call"}, {host.LevelTrace, "host.trace.mark"}, {host.LevelDebug, "host.sidecar.reply"},
	}
	for round := 0; round < 12; round++ {
		for _, event := range events {
			fields := map[string]any{"kind": strings.Repeat("x", 40)}
			switch event.name {
			case "host.panic":
				fields = map[string]any{"name": "n", "text": "t", "stack": "s"}
			case "host.crash.found":
				fields = map[string]any{"path": "p", "pid": 1, "time": "t"}
			case "host.binding.call":
				fields = map[string]any{"name": "echo", "args": "[]", "micros": 1, "ok": true, "truncated": false}
			case "host.sidecar.reply":
				fields = map[string]any{"name": "n", "surface": "s", "bytes": 1, "ok": true}
			case "host.trace.mark":
				fields = map[string]any{}
			}
			if !log.Emit(event.level, event.name, fields) {
				t.Fatalf("%s was refused", event.name)
			}
			counts[event.level]++
		}
	}
	if err := log.Flush(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	log.Close()
	return config, counts
}

func queryNames(t *testing.T, config, params string) (names []string, files map[string]bool) {
	t.Helper()
	query, err := sok.ParseLogQuery([]byte(params))
	if err != nil {
		t.Fatalf("%s: %v", params, err)
	}
	query.Limit = 5000
	page, err := sok.QueryLogs(config, query, nil)
	if err != nil {
		t.Fatalf("%s: %v", params, err)
	}
	files = map[string]bool{}
	for _, row := range page.Rows {
		var event struct {
			Event string `json:"event"`
		}
		if err := json.Unmarshal(row.Event, &event); err != nil {
			t.Fatal(err)
		}
		names = append(names, event.Event)
		files[row.File] = true
	}
	return names, files
}

// contract: log.query.reads-the-files-the-writer-wrote
func TestTheQueryReadsTheMainFilesAsOtherAndTheDebugFilesAsDebugAcrossGenerations(t *testing.T) {
	config, counts := writeMixedEvents(t)
	other, otherFiles := queryNames(t, config, `{"channel":"other"}`)
	debug, debugFiles := queryNames(t, config, `{"channel":"debug"}`)
	all, _ := queryNames(t, config, `{"channel":"all"}`)
	count := func(names []string, name string) int {
		n := 0
		for _, candidate := range names {
			if candidate == name {
				n++
			}
		}
		return n
	}
	for _, name := range []string{"host.binding.call", "host.trace.mark", "host.sidecar.reply"} {
		if count(other, name) != 0 {
			t.Errorf("the channel other holds %s", name)
		}
	}
	if count(other, "host.panic") != counts[host.LevelError] || count(other, "host.crash.found") != counts[host.LevelWarn] || count(other, "host.app.event") != counts[host.LevelInfo] {
		t.Errorf("the channel other holds %d panics, %d crash reports and %d app events, want %d, %d and %d", count(other, "host.panic"), count(other, "host.crash.found"),
			count(other, "host.app.event"), counts[host.LevelError], counts[host.LevelWarn], counts[host.LevelInfo])
	}
	if count(debug, "host.binding.call") != 12 || count(debug, "host.trace.mark") != counts[host.LevelTrace] || count(debug, "host.sidecar.reply") != 12 || count(debug, "host.app.event") != 0 {
		t.Errorf("the channel debug holds %v", debug)
	}
	if len(all) != len(other)+len(debug) {
		t.Errorf("the channel all holds %d rows, other %d and debug %d", len(all), len(other), len(debug))
	}
	// Both files rotated, so each channel reads generations.
	for channel, files := range map[string]map[string]bool{"other": otherFiles, "debug": debugFiles} {
		generations := 0
		for file := range files {
			if matched, _ := filepath.Match("logs/host-b1.*jsonl.[0-9]*", file); matched {
				generations++
			}
		}
		if generations < 2 {
			t.Errorf("the channel %s read %d generations: %v", channel, generations, sortedKeys(files))
		}
	}
}

// contract: log.query.matches-the-class-the-writer-stored
func TestTheFilterClassMatchesTheClassThatTheWriterStored(t *testing.T) {
	config, _ := writeMixedEvents(t)
	want := map[string][]string{
		"call":      {"host.binding.call", "host.trace.mark"},
		"io":        {"host.sidecar.reply"},
		"lifecycle": {"host.app.event", "host.crash.found", "host.panic", "log.open", "log.policy", "log.rotated"},
	}
	for class, names := range want {
		found, _ := queryNames(t, config, fmt.Sprintf(`{"channel":"all","class":%q}`, class))
		unique := map[string]bool{}
		for _, name := range found {
			unique[name] = true
		}
		if got := sortedKeys(unique); !reflect.DeepEqual(got, names) {
			t.Errorf("class %s matches the events %v, want %v", class, got, names)
		}
	}
	if found, _ := queryNames(t, config, `{"channel":"all","class":"frame"}`); len(found) != 0 {
		t.Errorf("class frame matches %v", found)
	}
}

func sortedKeys(set map[string]bool) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
