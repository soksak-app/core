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
		if err := log.Flush(); err != nil {
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
	generation, err := s.sourceOriginState().create("probe-surface")
	if err != nil {
		t.Fatal(err)
	}
	if current, ok := s.sourceOriginState().current("probe-surface"); !ok || current != generation {
		t.Fatalf("registered view origin is not current: generation %d, current %d, present %t", generation, current, ok)
	}
	handle := unsafe.Pointer(new(int))
	s.documents.registerView("probe-surface", "probe", generation, handle)
	key := DocumentKey{Surface: "probe-surface", Name: viewRegionName}
	if err := s.documents.Reserve(key); err != nil || !s.documents.Set(key, handle) {
		t.Fatalf("the document of the registered view: %v", err)
	}
	s.invoke = func(task func()) { task() }
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

const viewLogDeliveryChild = "SOKSAK_VIEW_LOG_DELIVERY_CHILD"

// readyViewLogSurfaces returns the registered view of the test surface with a ready document doc-1 and the event writer log.
func readyViewLogSurfaces(t *testing.T, log *EventLog) *Surfaces {
	t.Helper()
	s := registeredViewRecordSurfaces(t)
	s.host = &Host{events: log}
	if !s.documents.setReadyDocument("probe-surface", probeGeneration(s), "doc-1", 1234.5) {
		t.Fatal("the ready document was not recorded")
	}
	return s
}

// viewLogReplyForTest carries out the runtime.log call id with params for the view of the test surface and returns the reply message
// that the host posts to the document that made the call, as the page reads it.
func viewLogReplyForTest(t *testing.T, s *Surfaces, id uint64, params any) map[string]any {
	t.Helper()
	data, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	call := map[string]any{"id": id, "command": "runtime.log", "params": json.RawMessage(data)}
	answer, err := s.answerViewLog("probe-surface", "probe", probeGeneration(s), call)
	if err != nil || answer == nil {
		t.Fatalf("runtime.log call %d: answer %v, error %v", id, answer, err)
	}
	text, err := json.Marshal(answer.message)
	if err != nil {
		t.Fatal(err)
	}
	var reply map[string]any
	if err := json.Unmarshal(text, &reply); err != nil {
		t.Fatalf("runtime.log reply %q is not JSON: %v", text, err)
	}
	return reply
}

// contract: log.view-clock-answers-without-policy-or-event-write, view.log.uses-direct-writer, log.view-request-accepts-only-declared-clock-and-batch-fields, view.log.same-id-replies, log.view-batch.binds-ready-page-and-native-surface, log.view-batch.rejects-foreign-source-without-partial-write, log.view-batch-requires-page-start-to-match-ready-origin, log.view-batch-requires-a-nonempty-page-start-url, log.view-batch-refuses-a-caller-supplied-surface, log.view-batch-rejects-a-foreign-plugin-prefix
func TestViewRuntimeLogClockRepliesWithoutWorkbenchRelay(t *testing.T) {
	if config := os.Getenv(viewLogDeliveryChild); config != "" {
		log := startViewRecordWriter(t, config)
		s := readyViewLogSurfaces(t, log)
		var events []hostEvent
		s.events = func(name string, data any) { events = append(events, hostEvent{name, data}) }
		if err := log.Flush(); err != nil {
			t.Fatalf("flush before runtime.log clock: %v", err)
		}
		clockRecordCount := len(viewRecordEvents(t, config))
		// The reply post is refused by the fault point, so the call reaches the end of its path without the native post.
		t.Setenv(faultViewPost, "post")
		message := `{"message":{"sok":1,"id":7,"command":"runtime.log","params":{"action":"clock"}}}`
		if err := s.ViewMessage("probe-surface", message); err == nil || !strings.Contains(err.Error(), "post runtime.log reply") {
			t.Fatalf("runtime.log clock with a refused post: %v, want the post failure", err)
		}
		if len(events) != 0 {
			t.Fatalf("runtime.log clock reached the workbench: %+v, want no relayed event", events)
		}
		reply := viewLogReplyForTest(t, s, 7, map[string]any{"action": "clock"})
		result, ok := reply["result"].(map[string]any)
		if !ok || reply["id"] != float64(7) || result["ts_us"] == nil || result["mono_ns"] == nil {
			t.Fatalf("runtime.log clock reply: %v, want id 7 and host clocks", reply)
		}
		if err := log.Flush(); err != nil {
			t.Fatalf("flush after runtime.log clock: %v", err)
		}
		clockRecords := viewRecordEvents(t, config)
		if len(clockRecords) != clockRecordCount {
			t.Fatalf("runtime.log clock changed event record count: before %d, after %d, records %v", clockRecordCount, len(clockRecords), clockRecords)
		}

		batch := map[string]any{"action": "batch", "events": []any{
			map[string]any{"ts_us": 1234567, "mono_ns": 1234567890, "page": "doc-1", "level": "info", "event": "page.start",
				"fields": map[string]any{"time_origin": 1234.5, "url": "soksak://probe/ui/page.html"}},
			map[string]any{"ts_us": 1234568, "mono_ns": 1234568890, "page": "doc-1", "level": "info", "event": "page.log.clock",
				"fields": map[string]any{"trip_us": 1000, "resolution_us": 1}},
			map[string]any{"ts_us": 1234569, "mono_ns": 1234569890, "page": "doc-1", "level": "info", "event": "plugin.probe.measurement",
				"fields": map[string]any{"sample": "accepted"}},
		}}
		if got := viewLogReplyForTest(t, s, 8, batch); got["id"] != float64(8) || got["result"] != nil {
			t.Fatalf("runtime.log batch reply: %v, want id 8 and null result", got)
		}
		if err := log.Flush(); err != nil {
			t.Fatal(err)
		}
		stored := viewRecordEvents(t, config)
		if len(stored) == 0 {
			t.Fatal("the valid direct batch wrote no events")
		}
		seenStart, seenClock, seenPlugin := false, false, false
		for _, event := range stored {
			switch event["event"] {
			case "page.start":
				fields := event["fields"].(map[string]any)
				seenStart = event["page"] == "doc-1" && fields["time_origin"] == 1234.5
			case "page.log.clock":
				seenClock = event["page"] == "doc-1"
			case "plugin.probe.measurement":
				fields := event["fields"].(map[string]any)
				seenPlugin = event["page"] == "doc-1" && fields["surface"] == "probe-surface" && event["undeclared"] == true
			}
		}
		if !seenStart || !seenClock || !seenPlugin {
			t.Fatalf("stored direct view events: start %t clock %t plugin %t, records %v", seenStart, seenClock, seenPlugin, stored)
		}
		beforeRecords := len(stored)

		invalid := map[string]any{"action": "batch", "events": []any{
			map[string]any{"ts_us": 1234570, "mono_ns": 1234570890, "page": "doc-1", "level": "info", "event": "plugin.probe.atomic",
				"fields": map[string]any{"sample": "must-not-write"}},
			map[string]any{"ts_us": 1234571, "mono_ns": 1234571890, "page": "doc-1", "level": "info", "event": "plugin.other.foreign",
				"fields": map[string]any{"sample": "foreign"}},
		}}
		failure := viewLogReplyForTest(t, s, 9, invalid)
		if failure["id"] != float64(9) || failure["error"].(map[string]any)["code"] != float64(viewLogFailureCode) {
			t.Fatalf("foreign batch reply: %v, want id 9 with error code %d", failure, viewLogFailureCode)
		}
		if !strings.Contains(failure["error"].(map[string]any)["message"].(string), `event "plugin.other.foreign"`) {
			t.Fatalf("foreign batch error: %v, want the offending event name", failure)
		}
		if err := log.Flush(); err != nil {
			t.Fatal(err)
		}
		afterRecords := viewRecordEvents(t, config)
		if len(afterRecords) != beforeRecords {
			t.Fatalf("records after a rejected batch: %d, before %d; batch wrote before validating every owner", len(afterRecords), beforeRecords)
		}
		for _, event := range afterRecords {
			if event["event"] == "plugin.probe.atomic" || event["event"] == "plugin.other.foreign" || event["event"] == "host.view.call" {
				t.Fatalf("direct view log wrote a rejected or relayed event: %v", event)
			}
		}
		invalidRequests := []map[string]any{
			{"action": "clock", "unexpected": true},
			{"action": "batch", "events": []any{}, "unexpected": true},
			{"action": "batch", "events": []any{
				map[string]any{"ts_us": 1234583, "mono_ns": 1234583890, "page": "doc-1", "level": "info", "event": "page.start", "fields": map[string]any{"time_origin": 1234.5, "url": ""}},
			}},
			{"action": "batch", "events": []any{
				map[string]any{"ts_us": 1234580, "mono_ns": 1234580890, "page": "9999", "level": "info", "event": "plugin.probe.wrong-page", "fields": map[string]any{}},
			}},
			{"action": "batch", "events": []any{
				map[string]any{"ts_us": 1234581, "mono_ns": 1234581890, "page": "doc-1", "level": "info", "event": "plugin.probe.supplied-surface", "fields": map[string]any{"surface": "probe-surface"}},
			}},
			{"action": "batch", "events": []any{
				map[string]any{"ts_us": 1234582, "mono_ns": 1234582890, "page": "doc-1", "level": "info", "event": "page.start", "fields": map[string]any{"time_origin": 1234.6, "url": "soksak://probe/ui/page.html"}},
			}},
			{"action": "policy-read"},
			{"action": "policy", "classes": map[string]any{"lifecycle": "off"}},
			{"level": "info", "event": "input.key", "fields": map[string]any{"key": "legacy"}},
		}
		for index, request := range invalidRequests {
			id := uint64(10 + index)
			failure := viewLogReplyForTest(t, s, id, request)
			if failure["id"] != float64(id) || failure["error"].(map[string]any)["code"] != float64(viewLogFailureCode) {
				t.Fatalf("invalid runtime.log request %d reply: %v, want same id and error code %d", index, failure, viewLogFailureCode)
			}
			if err := log.Flush(); err != nil {
				t.Fatal(err)
			}
			if got := len(viewRecordEvents(t, config)); got != beforeRecords {
				t.Fatalf("records after invalid runtime.log request %d: %d, before %d", index, got, beforeRecords)
			}
		}
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run", "^TestViewRuntimeLogClockRepliesWithoutWorkbenchRelay$", "-test.count=1")
	command.Env = append(os.Environ(), viewLogDeliveryChild+"="+config)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("child runtime.log clock: %v: %s", err, output)
	}
	for _, event := range viewRecordEvents(t, config) {
		if event["event"] == "host.view.call" {
			t.Fatalf("clock event records include a workbench view call: %v", event)
		}
	}
}

// contract: log.view-batch-bounds-fields-after-surface-injection
func TestViewRuntimeLogSurfaceKeepsPluginFieldsWithinPageBound(t *testing.T) {
	if config := os.Getenv(viewLogDeliveryChild); config != "" {
		log := startViewRecordWriter(t, config)
		s := readyViewLogSurfaces(t, log)
		fields := map[string]any{"payload": strings.Repeat("x", 65520)}
		input, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		if len(input) > 65536 {
			t.Fatalf("test plugin fields are %d bytes, want no more than 65536", len(input))
		}
		withSurface := map[string]any{"payload": fields["payload"], "surface": "probe-surface"}
		injected, err := json.Marshal(withSurface)
		if err != nil {
			t.Fatal(err)
		}
		if len(injected) <= 65536 {
			t.Fatalf("test fields plus host surface are %d bytes, want more than 65536", len(injected))
		}
		batch := map[string]any{"action": "batch", "events": []any{
			map[string]any{"ts_us": 1234569, "mono_ns": 1234569890, "page": "doc-1", "level": "info", "event": "plugin.probe.near-limit", "fields": fields},
		}}
		viewLogReplyForTest(t, s, 31, batch)
		if err := log.Flush(); err != nil {
			t.Fatal(err)
		}
		for _, event := range viewRecordEvents(t, config) {
			if event["event"] != "plugin.probe.near-limit" {
				continue
			}
			stored, ok := event["fields"].(map[string]any)
			if !ok || stored["truncated"] != true || stored["surface"] != "probe-surface" {
				t.Fatalf("near-limit plugin fields: %v, want the truncation envelope and trusted surface", event["fields"])
			}
			storedText, err := json.Marshal(stored)
			if err != nil {
				t.Fatal(err)
			}
			if len(storedText) > 65536 {
				t.Fatalf("stored plugin fields are %d bytes, want no more than 65536", len(storedText))
			}
			head, ok := stored["head"].(string)
			if !ok || len(head) > 4096 || !strings.HasPrefix(head, `{"payload":"`) {
				t.Fatalf("near-limit plugin head: %v, want first 4096 bytes of serialized original fields", stored["head"])
			}
			if strings.Contains(head, "probe-surface") {
				t.Fatalf("host surface injection altered the preserved field head: %q", head)
			}
			return
		}
		t.Fatal("near-limit plugin event was not stored")
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run", "^TestViewRuntimeLogSurfaceKeepsPluginFieldsWithinPageBound$", "-test.count=1")
	command.Env = append(os.Environ(), viewLogDeliveryChild+"="+config)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("child plugin fields bound: %v: %s", err, output)
	}
}

// contract: view.ready.requires-document-and-positive-time-origin
func TestViewReadyRequiresDocumentAndPositiveTimeOrigin(t *testing.T) {
	for name, fields := range map[string]map[string]any{
		"no document":      {"time_origin": 1234.5},
		"empty document":   {"document": "", "time_origin": 1234.5},
		"no time origin":   {"document": "doc-1"},
		"zero time origin": {"document": "doc-1", "time_origin": 0},
		"negative":         {"document": "doc-1", "time_origin": -1},
		"text time origin": {"document": "doc-1", "time_origin": "1234.5"},
	} {
		t.Run(name, func(t *testing.T) {
			s, _, _ := newLifecycleSurfaces(t)
			ready := map[string]any{"event": "view.ready", "plugin": "probe"}
			for key, value := range fields {
				ready[key] = value
			}
			message, err := json.Marshal(map[string]any{"message": ready})
			if err != nil {
				t.Fatal(err)
			}
			if err := s.ViewMessage("probe-surface", string(message)); err == nil {
				t.Fatalf("view.ready %v was accepted", fields)
			}
			channel, ok := s.documents.view("probe-surface")
			if !ok || channel.document != "" || channel.timeOrigin != 0 {
				t.Fatalf("view channel after view.ready %v: %+v", fields, channel)
			}
			generation := channel.generation
			if _, ready, _, err := s.planViewPost("probe-surface", &generation, map[string]any{"event": "theme"}); err != nil || ready {
				t.Fatalf("the view is ready to receive a post after view.ready %v: ready %v, error %v", fields, ready, err)
			}
		})
	}
}

// contract: view.log-navigation-clears-ready-page
func TestViewRuntimeLogReplyDoesNotReachANavigatedDocument(t *testing.T) {
	if config := os.Getenv(viewLogDeliveryChild); config != "" {
		log := startViewRecordWriter(t, config)
		s := readyViewLogSurfaces(t, log)
		generation := probeGeneration(s)
		request := map[string]any{"action": "batch", "events": []any{
			map[string]any{"ts_us": 1234569, "mono_ns": 1234569890, "page": "doc-1", "level": "info", "event": "plugin.probe.before-navigation",
				"fields": map[string]any{"sample": "processed-before-navigation"}},
		}}
		data, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		answer, err := s.answerViewLog("probe-surface", "probe", generation, map[string]any{"id": uint64(17), "command": "runtime.log", "params": json.RawMessage(data)})
		if err != nil || answer == nil {
			t.Fatalf("runtime.log before navigation: answer %v, error %v", answer, err)
		}
		// The document navigates after the call was answered and before the reply is posted.
		if !s.documents.setReadyDocument("probe-surface", generation, "doc-2", 2345.5) {
			t.Fatal("could not replace the ready document before its reply post")
		}
		if post, stale, err := s.planViewDocumentPost("probe-surface", answer.generation, answer.document, answer.message); err != nil || !stale || post.handle != nil {
			t.Fatalf("the reply of the old document: post %+v, stale %v, error %v; want no post to the replacement document", post, stale, err)
		}
		if err := log.Flush(); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, event := range viewRecordEvents(t, config) {
			if event["event"] == "plugin.probe.before-navigation" {
				fields := event["fields"].(map[string]any)
				found = event["page"] == "doc-1" && fields["surface"] == "probe-surface"
			}
		}
		if !found {
			t.Fatal("the batch accepted from the current document was not stored with its captured page and surface")
		}
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run", "^TestViewRuntimeLogReplyDoesNotReachANavigatedDocument$", "-test.count=1")
	command.Env = append(os.Environ(), viewLogDeliveryChild+"="+config)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("child navigation identity: %v: %s", err, output)
	}
}

// contract: view.log.reply-post-failure-is-reported
func TestViewRuntimeLogNativeReplyPostFailureIsReported(t *testing.T) {
	if config := os.Getenv(viewLogDeliveryChild); config != "" {
		log := startViewRecordWriter(t, config)
		s := readyViewLogSurfaces(t, log)
		// The fault point refuses the post that the native layer would take.
		t.Setenv(faultViewPost, "post")
		handle, err := s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName})
		if err != nil {
			t.Fatal(err)
		}
		s.viewReceived("probe-surface", handle, "probe", probeGeneration(s),
			`{"message":{"sok":1,"id":18,"command":"runtime.log","params":{"action":"clock"}}}`)
		if err := log.Flush(); err != nil {
			t.Fatal(err)
		}
		for _, event := range viewRecordEvents(t, config) {
			if event["event"] == "host.record.error" {
				fields := event["fields"].(map[string]any)
				if fields["where"] == "view channel" && strings.Contains(fields["text"].(string), "post runtime.log reply") {
					return
				}
			}
		}
		t.Fatal("a failed native runtime.log reply post was not reported on the view error path")
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run", "^TestViewRuntimeLogNativeReplyPostFailureIsReported$", "-test.count=1")
	command.Env = append(os.Environ(), viewLogDeliveryChild+"="+config)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("child native post failure: %v: %s", err, output)
	}
}

// contract: view.log.retired-generation-cannot-write-as-replacement
func TestRetiredViewRuntimeLogDoesNotWriteThroughReplacement(t *testing.T) {
	if config := os.Getenv(viewLogDeliveryChild); config != "" {
		log := startViewRecordWriter(t, config)
		s, views, _ := newLifecycleSurfaces(t)
		s.host.events = log
		if !s.documents.setReadyDocument("probe-surface", probeGeneration(s), "doc-1", 1234.5) {
			t.Fatal("the ready document was not recorded")
		}
		retired, oldGeneration := retireAndReplaceView(t, s, views)
		if err := log.Flush(); err != nil {
			t.Fatal(err)
		}
		before := len(viewRecordEvents(t, config))
		s.viewReceived("probe-surface", retired, "probe", oldGeneration,
			`{"message":{"sok":1,"id":19,"command":"runtime.log","params":{"action":"batch","events":[{"ts_us":1234569,"mono_ns":1234569890,"page":"doc-1","level":"info","event":"plugin.probe.retired","fields":{}}]}}}`)
		if err := log.Flush(); err != nil {
			t.Fatal(err)
		}
		after := viewRecordEvents(t, config)
		if len(after) != before {
			t.Fatalf("records after retired runtime.log: %d, before %d", len(after), before)
		}
		for _, event := range after {
			if event["event"] == "plugin.probe.retired" || event["event"] == "host.view.call" {
				t.Fatalf("retired runtime.log reached the writer or workbench: %v", event)
			}
		}
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run", "^TestRetiredViewRuntimeLogDoesNotWriteThroughReplacement$", "-test.count=1")
	command.Env = append(os.Environ(), viewLogDeliveryChild+"="+config)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("child retired generation: %v: %s", err, output)
	}
}
