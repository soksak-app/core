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

const viewLogDeliveryChild = "SOKSAK_VIEW_LOG_DELIVERY_CHILD"

// contract: logging.view-runtime-log-directly-replies
func TestViewRuntimeLogClockRepliesWithoutWorkbenchRelay(t *testing.T) {
	if config := os.Getenv(viewLogDeliveryChild); config != "" {
		log := startViewRecordWriter(t, config)
		s, fake := newViewChannelSurfaces(t)
		s.host = &Host{events: log}
		var events []hostEvent
		s.events = func(name string, data any) { events = append(events, hostEvent{name, data}) }
		if err := s.ViewMessage("probe-surface", `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1","page":"1234.5"}}`); err != nil {
			t.Fatalf("view ready: %v", err)
		}
		fake.posted = nil
		events = nil
		message := `{"message":{"sok":1,"id":7,"command":"runtime.log","params":{"action":"clock"}}}`
		if err := s.ViewMessage("probe-surface", message); err != nil {
			t.Fatalf("runtime.log clock: %v", err)
		}
		if len(events) != 0 {
			t.Fatalf("runtime.log clock reached the workbench: %+v, want no relayed event", events)
		}
		if len(fake.posted) != 1 {
			t.Fatalf("native replies to runtime.log clock: %d, want one direct reply", len(fake.posted))
		}
		var reply map[string]any
		if err := json.Unmarshal([]byte(fake.posted[0]), &reply); err != nil {
			t.Fatalf("runtime.log clock reply %q is not JSON: %v", fake.posted[0], err)
		}
		result, ok := reply["result"].(map[string]any)
		if !ok || reply["id"] != float64(7) || result["ts_us"] == nil || result["mono_ns"] == nil {
			t.Fatalf("runtime.log clock native reply: %v, want id 7 and host clocks", reply)
		}

		batch := map[string]any{"action": "batch", "events": []any{
			map[string]any{"ts_us": 1234567, "mono_ns": 1234567890, "page": "1234.5", "level": "info", "event": "page.start",
				"fields": map[string]any{"time_origin": 1234.5, "url": "soksak://probe/ui/page.html"}},
			map[string]any{"ts_us": 1234568, "mono_ns": 1234568890, "page": "1234.5", "level": "info", "event": "page.log.clock",
				"fields": map[string]any{"trip_us": 1000, "resolution_us": 1}},
			map[string]any{"ts_us": 1234569, "mono_ns": 1234569890, "page": "1234.5", "level": "info", "event": "plugin.probe.measurement",
				"fields": map[string]any{"sample": "accepted"}},
		}}
		s.viewRuntimeLogForTest(t, fake, &events, 8, batch)
		if got := viewLogReplyForTest(t, fake).(map[string]any); got["id"] != float64(8) || got["result"] != nil {
			t.Fatalf("runtime.log batch native reply: %v, want id 8 and null result", got)
		}
		if len(events) != 0 {
			t.Fatalf("runtime.log batch reached the workbench: %+v, want no relayed event", events)
		}
		if err := log.Flush(5 * time.Second); err != nil {
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
				seenStart = event["page"] == "1234.5" && fields["time_origin"] == 1234.5
			case "page.log.clock":
				seenClock = event["page"] == "1234.5"
			case "plugin.probe.measurement":
				fields := event["fields"].(map[string]any)
				seenPlugin = event["page"] == "1234.5" && fields["surface"] == "probe-surface" && event["undeclared"] == true
			}
		}
		if !seenStart || !seenClock || !seenPlugin {
			t.Fatalf("stored direct view events: start %t clock %t plugin %t, records %v", seenStart, seenClock, seenPlugin, stored)
		}
		beforeRecords := len(stored)

		invalid := map[string]any{"action": "batch", "events": []any{
			map[string]any{"ts_us": 1234570, "mono_ns": 1234570890, "page": "1234.5", "level": "info", "event": "plugin.probe.atomic",
				"fields": map[string]any{"sample": "must-not-write"}},
			map[string]any{"ts_us": 1234571, "mono_ns": 1234571890, "page": "1234.5", "level": "info", "event": "plugin.other.foreign",
				"fields": map[string]any{"sample": "foreign"}},
		}}
		s.viewRuntimeLogForTest(t, fake, &events, 9, invalid)
		failure, ok := viewLogReplyForTest(t, fake).(map[string]any)
		if !ok || failure["id"] != float64(9) || failure["error"].(map[string]any)["code"] != float64(viewLogFailureCode) {
			t.Fatalf("foreign batch native reply: %v, want id 9 with error code %d", failure, viewLogFailureCode)
		}
		if !strings.Contains(failure["error"].(map[string]any)["message"].(string), `event "plugin.other.foreign"`) {
			t.Fatalf("foreign batch native error: %v, want the offending event name", failure)
		}
		if err := log.Flush(5 * time.Second); err != nil {
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
			{"action": "batch", "events": []any{
				map[string]any{"ts_us": 1234580, "mono_ns": 1234580890, "page": "9999", "level": "info", "event": "plugin.probe.wrong-page", "fields": map[string]any{}},
			}},
			{"action": "batch", "events": []any{
				map[string]any{"ts_us": 1234581, "mono_ns": 1234581890, "page": "1234.5", "level": "info", "event": "plugin.probe.supplied-surface", "fields": map[string]any{"surface": "probe-surface"}},
			}},
			{"action": "batch", "events": []any{
				map[string]any{"ts_us": 1234582, "mono_ns": 1234582890, "page": "1234.5", "level": "info", "event": "page.start", "fields": map[string]any{"time_origin": 1234.6, "url": "soksak://probe/ui/page.html"}},
			}},
			{"action": "policy-read"},
			{"action": "policy", "classes": map[string]any{"lifecycle": "off"}},
			{"level": "info", "event": "input.key", "fields": map[string]any{"key": "legacy"}},
		}
		for index, request := range invalidRequests {
			id := uint64(10 + index)
			s.viewRuntimeLogForTest(t, fake, &events, id, request)
			failure, ok := viewLogReplyForTest(t, fake).(map[string]any)
			if !ok || failure["id"] != float64(id) || failure["error"].(map[string]any)["code"] != float64(viewLogFailureCode) {
				t.Fatalf("invalid runtime.log request %d reply: %v, want same id and error code %d", index, failure, viewLogFailureCode)
			}
			if err := log.Flush(5 * time.Second); err != nil {
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

// contract: logging.view-runtime-log-surface-respects-page-field-bound
func TestViewRuntimeLogSurfaceKeepsPluginFieldsWithinPageBound(t *testing.T) {
	if config := os.Getenv(viewLogDeliveryChild); config != "" {
		log := startViewRecordWriter(t, config)
		s, fake := newViewChannelSurfaces(t)
		s.host = &Host{events: log}
		var events []hostEvent
		if err := s.ViewMessage("probe-surface", `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1","page":"1234.5"}}`); err != nil {
			t.Fatal(err)
		}
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
			map[string]any{"ts_us": 1234569, "mono_ns": 1234569890, "page": "1234.5", "level": "info", "event": "plugin.probe.near-limit", "fields": fields},
		}}
		s.viewRuntimeLogForTest(t, fake, &events, 31, batch)
		if err := log.Flush(5 * time.Second); err != nil {
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

// contract: logging.view-ready-binds-finite-page-origin
func TestViewReadyRequiresFiniteDecimalPageIdentity(t *testing.T) {
	for _, page := range []string{"", "0", "-1", "NaN", "Infinity", "0x1p4"} {
		t.Run(page, func(t *testing.T) {
			s, fake := newViewChannelSurfaces(t)
			ready := map[string]any{"event": "view.ready", "plugin": "probe", "document": "doc-1"}
			if page != "" {
				ready["page"] = page
			}
			message, err := json.Marshal(map[string]any{"message": ready})
			if err != nil {
				t.Fatal(err)
			}
			if err := s.ViewMessage("probe-surface", string(message)); err == nil {
				t.Fatalf("view.ready page %q was accepted", page)
			}
			channel, ok := s.documents.view("probe-surface")
			if !ok || channel.document != "" || channel.page != "" || len(fake.posted) != 0 {
				t.Fatalf("view channel after invalid page %q: %+v, posts %v", page, channel, fake.posted)
			}
		})
	}
}

// contract: logging.view-runtime-log-current-document-only
func TestViewRuntimeLogReplyDoesNotReachANavigatedDocument(t *testing.T) {
	if config := os.Getenv(viewLogDeliveryChild); config != "" {
		log := startViewRecordWriter(t, config)
		s, fake := newViewChannelSurfaces(t)
		s.host = &Host{events: log}
		if err := s.ViewMessage("probe-surface", `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1","page":"1234.5"}}`); err != nil {
			t.Fatal(err)
		}
		fake.posted = nil
		generation := viewGeneration(s, "probe-surface")
		fake.beforeUITask = func() {
			if !s.documents.setReadyDocument("probe-surface", generation, "doc-2", "2345.5") {
				t.Error("could not replace the ready document before its reply post")
			}
		}
		request := map[string]any{"action": "batch", "events": []any{
			map[string]any{"ts_us": 1234569, "mono_ns": 1234569890, "page": "1234.5", "level": "info", "event": "plugin.probe.before-navigation",
				"fields": map[string]any{"sample": "processed-before-navigation"}},
		}}
		message, err := json.Marshal(map[string]any{"message": map[string]any{"sok": 1, "id": 17, "command": "runtime.log", "params": request}})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.ViewMessage("probe-surface", string(message)); err != nil {
			t.Fatalf("runtime.log before navigation: %v", err)
		}
		if len(fake.posted) != 0 {
			t.Fatalf("old-document runtime.log replies: %v, want no post to the replacement document", fake.posted)
		}
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, event := range viewRecordEvents(t, config) {
			if event["event"] == "plugin.probe.before-navigation" {
				fields := event["fields"].(map[string]any)
				found = event["page"] == "1234.5" && fields["surface"] == "probe-surface"
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

// contract: logging.view-runtime-log-reply-post-failure-is-reported
func TestViewRuntimeLogNativeReplyPostFailureIsReported(t *testing.T) {
	if config := os.Getenv(viewLogDeliveryChild); config != "" {
		log := startViewRecordWriter(t, config)
		s, fake := newViewChannelSurfaces(t)
		s.host = &Host{events: log}
		if err := s.ViewMessage("probe-surface", `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1","page":"1234.5"}}`); err != nil {
			t.Fatal(err)
		}
		fake.rejectPost = true
		handle, err := s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName})
		if err != nil {
			t.Fatal(err)
		}
		s.viewReceived("probe-surface", handle, "probe", viewGeneration(s, "probe-surface"),
			`{"message":{"sok":1,"id":18,"command":"runtime.log","params":{"action":"clock"}}}`)
		if err := log.Flush(5 * time.Second); err != nil {
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

// contract: logging.view-runtime-log-retired-generation-is-cancelled
func TestRetiredViewRuntimeLogDoesNotWriteThroughReplacement(t *testing.T) {
	if config := os.Getenv(viewLogDeliveryChild); config != "" {
		log := startViewRecordWriter(t, config)
		s, fake, _ := newLifecycleSurfaces(t, &fakeClock{})
		s.host.events = log
		if err := s.ViewMessage("probe-surface", `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1","page":"1234.5"}}`); err != nil {
			t.Fatal(err)
		}
		retired, oldGeneration := retireAndReplaceView(t, s, fake)
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		before := len(viewRecordEvents(t, config))
		s.viewReceived("probe-surface", retired, "probe", oldGeneration,
			`{"message":{"sok":1,"id":19,"command":"runtime.log","params":{"action":"batch","events":[{"ts_us":1234569,"mono_ns":1234569890,"page":"1234.5","level":"info","event":"plugin.probe.retired","fields":{}}]}}}`)
		if err := log.Flush(5 * time.Second); err != nil {
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

func (s *Surfaces) viewRuntimeLogForTest(t *testing.T, fake *channelPlatform, events *[]hostEvent, id uint64, params any) {
	t.Helper()
	data, err := json.Marshal(map[string]any{"message": map[string]any{"sok": 1, "id": id, "command": "runtime.log", "params": params}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ViewMessage("probe-surface", string(data)); err != nil {
		t.Fatalf("runtime.log batch: %v", err)
	}
	if len(*events) != 0 {
		t.Fatalf("runtime.log reached the workbench: %+v", *events)
	}
	if len(fake.posted) == 0 {
		t.Fatal("runtime.log produced no native reply")
	}
}

func viewLogReplyForTest(t *testing.T, fake *channelPlatform) any {
	t.Helper()
	var reply map[string]any
	if err := json.Unmarshal([]byte(fake.posted[len(fake.posted)-1]), &reply); err != nil {
		t.Fatalf("runtime.log reply %q is not JSON: %v", fake.posted[len(fake.posted)-1], err)
	}
	return reply
}
