package host

// The channel of a plugin host page against a fake platform (docs/spec/plugin-host.md#channel).

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// hostEvent is one window event that the host sent to the main page in a test.
type hostEvent struct {
	name string
	data any
}

// channelSurfaces returns a Surfaces whose window has the host of plugin probe with a created web view and, when ready
// is set, the ready document "doc-1", and the record of the window events that the host sends. fake is the platform of the
// test, such as the channelPlatform of surfaces_test.go.
func channelSurfaces(t *testing.T, fake platform.Platform, ready bool) (*Surfaces, *[]hostEvent) {
	t.Helper()
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	events := &[]hostEvent{}
	s := &Surfaces{
		pluginHosts:        map[string]unsafe.Pointer{"probe": unsafe.Pointer(new(int))},
		pluginHostChannels: newPluginHostChannels(),
		theme:              Theme{Tokens: map[string]string{}},
		events:             func(name string, data any) { *events = append(*events, hostEvent{name, data}) },
	}
	s.pluginHostChannels.register("probe")
	if ready {
		s.pluginHostChannels.setReadyDocument("probe", "doc-1")
		s.pluginHostChannels.firstReady("probe")
	}
	return s, events
}

// hostMessage returns the envelope of the sok-view handler of a host page around the message value.
func hostMessage(value string) string {
	return `{"message": ` + value + `}`
}

// contract: plugin-host.channel.reply
func TestPluginHostChannelRelaysAReplyToTheMainPage(t *testing.T) {
	s, events := channelSurfaces(t, &channelPlatform{}, true)
	if err := s.pluginHostMessage("probe", hostMessage(`{"reply": 7, "result": {"sum": 3}}`)); err != nil {
		t.Fatalf("relay of a reply: %v", err)
	}
	want := []hostEvent{{"plugin-host-reply", map[string]any{"plugin": "probe", "id": uint64(7), "result": json.RawMessage(`{"sum": 3}`)}}}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("events %v, want %v", *events, want)
	}
	// A reply with both or neither of result and error, an error without a code or a message, and a reply id that is not an
	// integer are refused and relay nothing.
	for _, message := range []string{
		`{"reply": 7}`,
		`{"reply": 7, "result": 1, "error": {"code": -32000, "message": "x"}}`,
		`{"reply": 7, "error": {"message": "x"}}`,
		`{"reply": 7, "error": {"code": -32000}}`,
		`{"reply": "7", "result": 1}`,
	} {
		if err := s.pluginHostMessage("probe", hostMessage(message)); err == nil {
			t.Fatalf("reply %s is accepted", message)
		}
	}
	if len(*events) != 1 {
		t.Fatalf("a refused reply was relayed: %v", *events)
	}
}

// contract: plugin-host.channel.call-served-set
func TestPluginHostChannelForwardsOnlyTheRegistrationCalls(t *testing.T) {
	fake := &channelPlatform{}
	s, events := channelSurfaces(t, fake, true)
	for _, command := range []string{"runtime.native.call", "runtime.sidecar.send", "tab.state.read", "runtime.clipboard.read", "runtime.links.open"} {
		if err := s.pluginHostMessage("probe", hostMessage(`{"id": 4, "command": "`+command+`", "params": {"name": "x"}}`)); err != nil {
			t.Fatalf("unserved call %s: %v", command, err)
		}
		want := `{"error":{"code":-32000,"message":"plugin host call ` + command + ` is not served"},"id":4,"sok":1}`
		if len(fake.posted) == 0 || fake.posted[len(fake.posted)-1] != want {
			t.Fatalf("posted %v, want the refusal %s", fake.posted, want)
		}
	}
	if len(*events) != 0 || len(s.pluginHostChannels.openCalls("probe")) != 0 {
		t.Fatalf("a refused call was forwarded: events %v, open %v", *events, s.pluginHostChannels.openCalls("probe"))
	}
	for _, message := range []string{
		`{"id": 5, "command": "page.exposure.register", "params": {"name": "probe.x"}}`,
		`{"id": 6, "command": "runtime.command.register", "params": {"name": "probe.x"}}`,
	} {
		if err := s.pluginHostMessage("probe", hostMessage(message)); err != nil {
			t.Fatalf("served call %s: %v", message, err)
		}
	}
	want := []hostEvent{
		{"plugin-host-call", map[string]any{"plugin": "probe", "id": uint64(5), "command": "page.exposure.register", "params": json.RawMessage(`{"name": "probe.x"}`)}},
		{"plugin-host-call", map[string]any{"plugin": "probe", "id": uint64(6), "command": "runtime.command.register", "params": json.RawMessage(`{"name": "probe.x"}`)}},
	}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("events %v, want %v", *events, want)
	}
	if calls := s.pluginHostChannels.openCalls("probe"); !reflect.DeepEqual(calls, []string{"page.exposure.register", "runtime.command.register"}) {
		t.Fatalf("open calls %v, want the forwarded calls", calls)
	}
	// A cancel goes to the main page, which ends the pending call; the host keeps the call open until the reply of the main
	// page, as it does for a view.
	if err := s.pluginHostMessage("probe", hostMessage(`{"id": 5, "cancel": true}`)); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if last := (*events)[len(*events)-1]; !reflect.DeepEqual(last, hostEvent{"plugin-host-call", map[string]any{"plugin": "probe", "id": uint64(5), "cancel": true}}) {
		t.Fatalf("cancel event %v", last)
	}
	if err := s.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", ID: 5, Result: json.RawMessage(`null`)}); err != nil {
		t.Fatalf("answer: %v", err)
	}
	if calls := s.pluginHostChannels.openCalls("probe"); !reflect.DeepEqual(calls, []string{"runtime.command.register"}) {
		t.Fatalf("open calls after the answer %v", calls)
	}
	// A call without an integer id, with an empty command, or a cancel that names a command is refused.
	for _, message := range []string{`{"command": "x"}`, `{"id": 9, "command": ""}`, `{"id": 9, "cancel": true, "command": "x"}`} {
		if err := s.pluginHostMessage("probe", hostMessage(message)); err == nil {
			t.Fatalf("call %s is accepted", message)
		}
	}
}

// contract: plugin-host.channel.snapshot
func TestPluginHostChannelRelaysADeclaredUISnapshot(t *testing.T) {
	s, events := channelSurfaces(t, &channelPlatform{}, true)
	if err := s.pluginHostMessage("probe", hostMessage(`{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "seq": 2, "skipped": 1, "value": {"x": 1}}`)); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	want := []hostEvent{{"declared-ui.snapshot", map[string]any{"plugin": "probe", "status": "list", "seq": uint64(2), "skipped": uint64(1), "value": json.RawMessage(`{"x": 1}`)}}}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("events %v, want %v", *events, want)
	}
	for _, message := range []string{
		`{"event": "declared-ui.snapshot", "status": "list", "seq": 2, "skipped": 0, "value": null}`,
		`{"event": "declared-ui.snapshot", "plugin": "other", "status": "list", "seq": 2, "skipped": 0, "value": null}`,
		`{"event": "declared-ui.snapshot", "plugin": "probe", "seq": 2, "skipped": 0, "value": null}`,
		`{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "skipped": 0, "value": null}`,
		`{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "seq": 0, "skipped": 0, "value": null}`,
		`{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "seq": 2, "value": null}`,
		`{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "seq": 2, "skipped": 0}`,
	} {
		if err := s.pluginHostMessage("probe", hostMessage(message)); err == nil {
			t.Fatalf("snapshot %s is accepted", message)
		}
	}
	if len(*events) != 1 {
		t.Fatalf("a refused snapshot was relayed: %v", *events)
	}
}

// contract: plugin-host.channel.ready-theme
func TestPluginHostChannelReadyRecordsTheDocumentAndPostsTheTheme(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, false)
	// A host without a ready document receives no theme change.
	s.postThemeToPluginHosts()
	if len(fake.posted) != 0 {
		t.Fatalf("a host without a ready document received %v", fake.posted)
	}
	if err := s.pluginHostMessage("probe", hostMessage(`{"event": "view.ready", "plugin": "probe", "document": "doc-1"}`)); err != nil {
		t.Fatalf("ready: %v", err)
	}
	if channel, _ := s.pluginHostChannels.channel("probe"); channel.document != "doc-1" {
		t.Fatalf("ready document %q, want doc-1", channel.document)
	}
	if len(fake.posted) != 1 || !strings.Contains(fake.posted[0], `"event":"theme"`) {
		t.Fatalf("posted %v, want the theme after the ready message", fake.posted)
	}
	s.postThemeToPluginHosts()
	if len(fake.posted) != 2 || !strings.Contains(fake.posted[1], `"event":"theme"`) {
		t.Fatalf("posted %v, want the theme change", fake.posted)
	}
	// A navigation clears the ready document.
	s.pluginHostState("probe", `{"loading": true}`)
	if channel, _ := s.pluginHostChannels.channel("probe"); channel.document != "" {
		t.Fatalf("ready document %q after a navigation, want none", channel.document)
	}
	// A ready message of another plugin, or without a document, is refused.
	for _, message := range []string{`{"event": "view.ready", "plugin": "other", "document": "d"}`, `{"event": "view.ready", "plugin": "probe"}`} {
		if err := s.pluginHostMessage("probe", hostMessage(message)); err == nil {
			t.Fatalf("ready message %s is accepted", message)
		}
	}
	// An unknown event is refused with its name.
	if err := s.pluginHostMessage("probe", hostMessage(`{"event": "runtime.native.event"}`)); err == nil || !strings.Contains(err.Error(), `"runtime.native.event" is unknown`) {
		t.Fatalf("unknown event: err %v", err)
	}
}

// closingPlatform records the posts and counts the disposals of host web views.
type closingPlatform struct {
	channelPlatform
	closed int
}

func (p *closingPlatform) CloseDocument(unsafe.Pointer) { p.closed++ }

// contract: plugin-host.channel.queue-full-closes
func TestPluginHostChannelQueueFullClosesTheHost(t *testing.T) {
	fake := &closingPlatform{}
	s, events := channelSurfaces(t, fake, true)
	s.pluginHostReceived("probe", hostMessage(`{"event": "view.error", "reason": "queue full for probe"}`))
	if fake.closed != 1 {
		t.Fatalf("the host web view was closed %d times, want once", fake.closed)
	}
	if _, ok := s.pluginHosts["probe"]; ok {
		t.Fatalf("the host web view of probe is recorded after the queue overflow")
	}
	if _, ok := s.pluginHostChannels.channel("probe"); ok {
		t.Fatalf("the channel of probe is recorded after the queue overflow")
	}
	if !reflect.DeepEqual(*events, []hostEvent{{"plugin-host-ended", map[string]any{"plugin": "probe"}}}) {
		t.Fatalf("events %v, want plugin-host-ended", *events)
	}
	// Another view.error reason is an error line that closes nothing.
	s.pluginHostChannels.register("probe")
	s.pluginHosts["probe"] = unsafe.Pointer(new(int))
	if err := s.pluginHostMessage("probe", hostMessage(`{"event": "view.error", "reason": "message without the sok marker"}`)); err == nil {
		t.Fatalf("a view.error without a queue overflow is no error")
	}
	if fake.closed != 1 {
		t.Fatalf("a view.error without a queue overflow closed the host: %d", fake.closed)
	}
}

// contract: plugin-host.channel.ended
func TestPluginHostChannelEndTellsTheMainPage(t *testing.T) {
	fake := &closingPlatform{}
	s, events := channelSurfaces(t, fake, true)
	handle := s.pluginHosts["probe"]
	// The end of a web view that is no longer the host of the plugin changes nothing.
	s.pluginHostEnded("probe", unsafe.Pointer(new(int)))
	if fake.closed != 0 || len(*events) != 0 {
		t.Fatalf("the end of a replaced web view closed %d and sent %v", fake.closed, *events)
	}
	s.pluginHostEnded("probe", handle)
	if fake.closed != 1 || !reflect.DeepEqual(*events, []hostEvent{{"plugin-host-ended", map[string]any{"plugin": "probe"}}}) {
		t.Fatalf("the process end closed %d and sent %v, want one close and plugin-host-ended", fake.closed, *events)
	}
	// The disposal on a removal of the plugin sends the event; the disposal of every host on a reload sends none.
	s.pluginHosts["probe"] = unsafe.Pointer(new(int))
	s.pluginHostChannels.register("probe")
	s.disposePluginHost("probe")
	if len(*events) != 2 || (*events)[1].name != "plugin-host-ended" {
		t.Fatalf("the disposal sent %v, want a second plugin-host-ended", *events)
	}
	s.pluginHosts["probe"] = unsafe.Pointer(new(int))
	s.pluginHostChannels.register("probe")
	s.disposePluginHosts()
	if len(*events) != 2 {
		t.Fatalf("the disposal of every host sent %v", *events)
	}
	if _, ok := s.pluginHostChannels.channel("probe"); ok {
		t.Fatalf("the channel of probe is recorded after the disposal of every host")
	}
}

// contract: plugin-host.channel.main-page-posts
func TestPluginHostChannelPostsTheMessagesOfTheMainPage(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, true)
	if err := s.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", ID: 7, Result: json.RawMessage(`1`)}); err != nil {
		t.Fatalf("reply post: %v", err)
	}
	if err := s.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", ID: 8, Error: &ViewReplyError{Code: -32000, Message: "refused"}}); err != nil {
		t.Fatalf("error reply post: %v", err)
	}
	if err := s.pushPluginHostRequest(PluginHostRequestRequest{Plugin: "probe", ID: 9, Command: "declared-ui.snapshot.request", Params: json.RawMessage(`{"status":"x"}`)}); err != nil {
		t.Fatalf("request post: %v", err)
	}
	if err := s.pushPluginHostEvent(PluginHostEventRequest{Plugin: "probe", Event: "declared-ui.snapshot.ack", Data: json.RawMessage(`{"plugin":"probe","status":"x","seq":1}`)}); err != nil {
		t.Fatalf("event post: %v", err)
	}
	want := []string{
		`{"id":7,"result":1,"sok":1}`,
		`{"error":{"code":-32000,"message":"refused"},"id":8,"sok":1}`,
		`{"command":"declared-ui.snapshot.request","id":9,"params":{"status":"x"},"sok":1}`,
		`{"data":{"plugin":"probe","status":"x","seq":1},"event":"declared-ui.snapshot.ack","sok":1}`,
	}
	if !reflect.DeepEqual(fake.posted, want) {
		t.Fatalf("posted %v, want %v", fake.posted, want)
	}
	// A host without a ready document refuses the posts of the main page with its plugin.
	empty, _ := channelSurfaces(t, &channelPlatform{}, false)
	for _, post := range []func() error{
		func() error {
			return empty.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", ID: 7, Result: json.RawMessage(`1`)})
		},
		func() error {
			return empty.pushPluginHostRequest(PluginHostRequestRequest{Plugin: "probe", ID: 8, Command: "x"})
		},
		func() error {
			return empty.pushPluginHostEvent(PluginHostEventRequest{Plugin: "probe", Event: "x", Data: json.RawMessage(`1`)})
		},
	} {
		if err := post(); err == nil || err.Error() != "plugin probe has no ready document" {
			t.Fatalf("post without a ready document: err %v", err)
		}
	}
	// A reply with neither a result nor an error, a request without a command, and an event without a name are refused.
	for _, post := range []func() error{
		func() error { return s.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", ID: 7}) },
		func() error { return s.pushPluginHostRequest(PluginHostRequestRequest{Plugin: "probe", ID: 8}) },
		func() error {
			return s.pushPluginHostEvent(PluginHostEventRequest{Plugin: "probe", Data: json.RawMessage(`1`)})
		},
	} {
		if err := post(); err == nil {
			t.Fatalf("an invalid post of the main page is accepted")
		}
	}
}
