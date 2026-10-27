package host

// The channel of a plugin host page against a fake platform (docs/spec/plugin-host.md#channel).

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"unsafe"
)

// hostEvent is one window event that the host sent to the main page in a test.
type hostEvent struct {
	name string
	data any
}

func registerPluginHostChannel(s *Surfaces, plugin string, state *hostState) uint64 {
	generation, err := s.sourceOriginState().create(plugin, false)
	if err != nil {
		panic(err)
	}
	s.pluginHostChannels.register(plugin, state, generation)
	return generation
}

type replacePluginHostOnPost struct {
	*channelPlatform
	afterPost func()
}

func (p *replacePluginHostOnPost) PostDocument(document unsafe.Pointer, value string) bool {
	accepted := p.channelPlatform.PostDocument(document, value)
	if p.afterPost != nil {
		p.afterPost()
	}
	return accepted
}

// channelSurfaces returns a Surfaces whose window has the host of plugin probe with a created web view and, when ready
// is set, the ready document "doc-1", and the record of the window events that the host sends. fake is the platform of the
// test, such as the channelPlatform of surfaces_test.go.
func channelSurfaces(t *testing.T, fake uiFake, ready bool) (*Surfaces, *[]hostEvent) {
	t.Helper()
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	events := &[]hostEvent{}
	s := &Surfaces{
		invoke:             fake.runUITask,
		pluginHosts:        map[string]unsafe.Pointer{"probe": unsafe.Pointer(new(int))},
		pluginHostChannels: newPluginHostChannels(),
		pluginHostStates:   newPluginHostStates(),
		pluginHostRestarts: newPluginHostRestarts(),
		theme:              Theme{Tokens: map[string]string{}},
		events:             func(name string, data any) { *events = append(*events, hostEvent{name, data}) },
	}
	registerPluginHostChannel(s, "probe", nil)
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
	want := []hostEvent{{"plugin-host-reply", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(7), "result": json.RawMessage(`{"sum": 3}`)}}}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("events %v, want %v", *events, want)
	}
	if err := s.pluginHostMessage("probe", hostMessage(`{"reply": 8, "result": null}`)); err != nil {
		t.Fatalf("relay of a null result: %v", err)
	}
	if got := (*events)[1]; got.name != "plugin-host-reply" || !reflect.DeepEqual(got.data, map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(8), "result": json.RawMessage(`null`)}) {
		t.Fatalf("null result event %v, want an explicit null result", got)
	}
	// A reply with both or neither of result and error, an error without a code or a message, and a reply id that is not an
	// integer are refused and relay nothing.
	for _, message := range []string{
		`{"reply": 7}`,
		`{"reply": 7, "result": null, "error": {"code": -32000, "message": "x"}}`,
		`{"reply": 7, "result": 1, "error": null}`,
		`{"reply": 7, "result": null, "error": null}`,
		`{"reply": 7, "error": null}`,
		`{"reply": 7, "result": 1, "error": {"code": -32000, "message": "x"}}`,
		`{"reply": 7, "error": {"message": "x"}}`,
		`{"reply": 7, "error": {"code": -32000}}`,
		`{"reply": "7", "result": 1}`,
	} {
		if err := s.pluginHostMessage("probe", hostMessage(message)); err == nil {
			t.Fatalf("reply %s is accepted", message)
		}
	}
	if len(*events) != 2 {
		t.Fatalf("a refused reply was relayed: %v", *events)
	}
}

// contract: plugin-host.channel.call-served-set
func TestPluginHostChannelForwardsOnlyTheRegistrationCalls(t *testing.T) {
	fake := &channelPlatform{}
	s, events := channelSurfaces(t, fake, true)
	for _, command := range []string{"runtime.native.off", "runtime.sidecar.close", "tab.state.read", "runtime.clipboard.read", "runtime.links.open"} {
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
		`{"id": 7, "command": "runtime.native.on", "params": {"name": "probe.x"}}`,
		`{"id": 8, "command": "runtime.native.call", "params": {"name": "probe.x"}}`,
	} {
		if err := s.pluginHostMessage("probe", hostMessage(message)); err != nil {
			t.Fatalf("served call %s: %v", message, err)
		}
	}
	want := []hostEvent{
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(5), "command": "page.exposure.register", "params": json.RawMessage(`{"name": "probe.x"}`)}},
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(6), "command": "runtime.command.register", "params": json.RawMessage(`{"name": "probe.x"}`)}},
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(7), "command": "runtime.native.on", "params": json.RawMessage(`{"name": "probe.x"}`)}},
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(8), "command": "runtime.native.call", "params": json.RawMessage(`{"name": "probe.x"}`)}},
	}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("events %v, want %v", *events, want)
	}
	if calls := s.pluginHostChannels.openCalls("probe"); !reflect.DeepEqual(calls, []string{"page.exposure.register", "runtime.command.register", "runtime.native.on", "runtime.native.call"}) {
		t.Fatalf("open calls %v, want the forwarded calls", calls)
	}
	// A cancel goes to the main page, which ends the pending call; the host keeps the call open until the reply of the main
	// page, as it does for a view.
	if err := s.pluginHostMessage("probe", hostMessage(`{"id": 5, "cancel": true}`)); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if last := (*events)[len(*events)-1]; !reflect.DeepEqual(last, hostEvent{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(5), "cancel": true}}) {
		t.Fatalf("cancel event %v", last)
	}
	if err := s.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", Generation: 1, ID: 5, Result: json.RawMessage(`null`)}); err != nil {
		t.Fatalf("answer: %v", err)
	}
	if calls := s.pluginHostChannels.openCalls("probe"); !reflect.DeepEqual(calls, []string{"runtime.command.register", "runtime.native.on", "runtime.native.call"}) {
		t.Fatalf("open calls after the answer %v", calls)
	}
	// A call without an integer id, with an empty command, or a cancel that names a command is refused.
	for _, message := range []string{`{"command": "x"}`, `{"id": 9, "command": ""}`, `{"id": 9, "cancel": true, "command": "x"}`} {
		if err := s.pluginHostMessage("probe", hostMessage(message)); err == nil {
			t.Fatalf("call %s is accepted", message)
		}
	}
}

// contract: plugin-host.channel.call-served-set
func TestPluginHostChannelForwardsTheSidecarCalls(t *testing.T) {
	fake := &channelPlatform{}
	s, events := channelSurfaces(t, fake, true)
	params := `{"id": "plugin:probe:project-a:fixture-sidecar", "sidecar": "fixture-sidecar"}`
	for id, command := range []string{"runtime.sidecar.send", "runtime.sidecar.on", "runtime.sidecar.onFailure"} {
		message := `{"id": ` + fmt.Sprint(id+10) + `, "command": "` + command + `", "params": ` + params + `}`
		if err := s.pluginHostMessage("probe", hostMessage(message)); err != nil {
			t.Fatalf("served call %s: %v", command, err)
		}
	}
	if len(fake.posted) != 0 {
		t.Fatalf("a served sidecar call was refused or answered by the host: %v", fake.posted)
	}
	want := []hostEvent{
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(10), "command": "runtime.sidecar.send", "params": json.RawMessage(params)}},
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(11), "command": "runtime.sidecar.on", "params": json.RawMessage(params)}},
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(12), "command": "runtime.sidecar.onFailure", "params": json.RawMessage(params)}},
	}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("events %v, want %v", *events, want)
	}
	if calls := s.pluginHostChannels.openCalls("probe"); !reflect.DeepEqual(calls, []string{"runtime.sidecar.send", "runtime.sidecar.on", "runtime.sidecar.onFailure"}) {
		t.Fatalf("open calls %v, want the forwarded sidecar calls", calls)
	}
}

// contract: plugin-host.data.calls
func TestPluginHostChannelForwardsTheProjectDataCalls(t *testing.T) {
	fake := &channelPlatform{}
	s, events := channelSurfaces(t, fake, true)
	for _, message := range []string{
		`{"id": 13, "command": "runtime.data.get", "params": {"key": "note"}}`,
		`{"id": 14, "command": "runtime.data.set", "params": {"key": "note", "value": "new"}}`,
	} {
		if err := s.pluginHostMessage("probe", hostMessage(message)); err != nil {
			t.Fatalf("served data call %s: %v", message, err)
		}
	}
	if len(fake.posted) != 0 {
		t.Fatalf("a served data call was refused or answered by the host: %v", fake.posted)
	}
	want := []hostEvent{
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(13), "command": "runtime.data.get", "params": json.RawMessage(`{"key": "note"}`)}},
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(14), "command": "runtime.data.set", "params": json.RawMessage(`{"key": "note", "value": "new"}`)}},
	}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("events %v, want %v", *events, want)
	}
}

// contract: plugin-host.error.display
func TestPluginHostChannelForwardsTheErrorCall(t *testing.T) {
	fake := &channelPlatform{}
	s, events := channelSurfaces(t, fake, true)
	message := `{"id": 15, "command": "runtime.error", "params": {"where": "listing", "text": "cannot read folder"}}`
	if err := s.pluginHostMessage("probe", hostMessage(message)); err != nil {
		t.Fatalf("served error call %s: %v", message, err)
	}
	if len(fake.posted) != 0 {
		t.Fatalf("a served error call was refused or answered by the host: %v", fake.posted)
	}
	want := []hostEvent{
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(15), "command": "runtime.error", "params": json.RawMessage(`{"where": "listing", "text": "cannot read folder"}`)}},
	}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("events %v, want %v", *events, want)
	}
}

// contract: plugin-host.command.run
func TestPluginHostChannelForwardsTheCommandCall(t *testing.T) {
	fake := &channelPlatform{}
	s, events := channelSurfaces(t, fake, true)
	message := `{"id": 16, "command": "runtime.command", "params": {"name": "core.file.open", "params": {"path": "notes.md"}}}`
	if err := s.pluginHostMessage("probe", hostMessage(message)); err != nil {
		t.Fatalf("served command call %s: %v", message, err)
	}
	if len(fake.posted) != 0 {
		t.Fatalf("a served command call was refused or answered by the host: %v", fake.posted)
	}
	want := []hostEvent{
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(16), "command": "runtime.command", "params": json.RawMessage(`{"name": "core.file.open", "params": {"path": "notes.md"}}`)}},
	}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("events %v, want %v", *events, want)
	}
}

// contract: plugin-host.log.write
func TestPluginHostChannelForwardsTheLogCall(t *testing.T) {
	fake := &channelPlatform{}
	s, events := channelSurfaces(t, fake, true)
	message := `{"id": 17, "command": "runtime.log", "params": {"level": "info", "event": "input.key", "fields": {"key": "a"}, "cids": ["c.1"]}}`
	if err := s.pluginHostMessage("probe", hostMessage(message)); err != nil {
		t.Fatalf("served log call %s: %v", message, err)
	}
	if len(fake.posted) != 0 {
		t.Fatalf("a served log call was refused or answered by the host: %v", fake.posted)
	}
	want := []hostEvent{
		{"plugin-host-call", map[string]any{"plugin": "probe", "generation": uint64(1), "id": uint64(17), "command": "runtime.log", "params": json.RawMessage(`{"level": "info", "event": "input.key", "fields": {"key": "a"}, "cids": ["c.1"]}`)}},
	}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("events %v, want %v", *events, want)
	}
}

// contract: plugin-host.channel.snapshot
func TestPluginHostChannelRelaysADeclaredUISnapshot(t *testing.T) {
	s, events := channelSurfaces(t, &channelPlatform{}, true)
	if err := s.pluginHostMessage("probe", hostMessage(`{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "seq": 2, "skipped": 1, "value": {"x": 1}}`)); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	generation, _ := s.pluginHostChannels.generation("probe")
	want := []hostEvent{{"declared-ui-snapshot", map[string]any{"plugin": "probe", "generation": generation, "status": "list", "seq": uint64(2), "skipped": uint64(1), "value": json.RawMessage(`{"x": 1}`)}}}
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

// pluginHostNavigationState is the document state of a host page as the native host sends it: loading and the count of navigations.
func pluginHostNavigationState(loading bool, navigations uint64) string {
	return fmt.Sprintf(`{"loading": %t, "navigations": %d}`, loading, navigations)
}

// contract: plugin-host.channel.state-navigations-required
func TestPluginHostStateRequiresNavigationsAndRefusesALowerCount(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, false)
	s.pluginHostState("probe", pluginHostNavigationState(true, 1))
	if err := s.pluginHostMessage("probe", hostMessage(`{"event": "view.ready", "plugin": "probe", "document": "doc-1"}`)); err != nil {
		t.Fatalf("ready: %v", err)
	}
	// A state without navigations is refused and clears nothing; a lower count is refused and clears nothing.
	s.pluginHostState("probe", `{"loading": true}`)
	s.pluginHostState("probe", pluginHostNavigationState(true, 0))
	if channel, _ := s.pluginHostChannels.channel("probe"); channel.document != "doc-1" {
		t.Fatalf("ready document %q after the refused states, want doc-1", channel.document)
	}
}

// contract: plugin-host.channel.ready-theme
// contract: plugin-host.channel.progress-keeps-ready
func TestPluginHostChannelReadyRecordsTheDocumentAndPostsTheTheme(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, false)
	// A host without a ready document receives no theme change.
	s.postThemeToPluginHosts()
	if len(fake.posted) != 0 {
		t.Fatalf("a host without a ready document received %v", fake.posted)
	}
	// The navigation starts before the page script runs, so its state arrives before the ready message.
	s.pluginHostState("probe", pluginHostNavigationState(true, 1))
	if err := s.pluginHostMessage("probe", hostMessage(`{"event": "view.ready", "plugin": "probe", "document": "doc-1"}`)); err != nil {
		t.Fatalf("ready: %v", err)
	}
	if channel, _ := s.pluginHostChannels.channel("probe"); channel.document != "doc-1" {
		t.Fatalf("ready document %q, want doc-1", channel.document)
	}
	if len(fake.posted) != 2 || !strings.Contains(fake.posted[0], `"event":"theme"`) ||
		!strings.Contains(fake.posted[1], `"event":"project"`) {
		t.Fatalf("posted %v, want the theme then current project after the ready message", fake.posted)
	}
	s.postThemeToPluginHosts()
	if len(fake.posted) != 3 || !strings.Contains(fake.posted[2], `"event":"theme"`) {
		t.Fatalf("posted %v, want the theme change", fake.posted)
	}
	// The progress of the same navigation keeps the ready document.
	s.pluginHostState("probe", pluginHostNavigationState(true, 1))
	if channel, _ := s.pluginHostChannels.channel("probe"); channel.document != "doc-1" {
		t.Fatalf("ready document %q after the progress of the same navigation, want doc-1", channel.document)
	}
	// A new navigation clears the ready document.
	s.pluginHostState("probe", pluginHostNavigationState(true, 2))
	if channel, _ := s.pluginHostChannels.channel("probe"); channel.document != "" {
		t.Fatalf("ready document %q after a new navigation, want none", channel.document)
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
	_, err := s.pluginHostReceived("probe", s.pluginHostChannels.instance("probe"), hostMessage(`{"event": "view.error", "reason": "queue full for probe"}`))
	if err == nil {
		t.Fatal("queue overflow was not reported")
	}
	if fake.closed != 1 {
		t.Fatalf("the host web view was closed %d times, want once", fake.closed)
	}
	if _, ok := s.pluginHosts["probe"]; ok {
		t.Fatalf("the host web view of probe is recorded after the queue overflow")
	}
	if _, ok := s.pluginHostChannels.channel("probe"); ok {
		t.Fatalf("the channel of probe is recorded after the queue overflow")
	}
	if !reflect.DeepEqual(*events, []hostEvent{{"declared-ui-source-ended", map[string]any{"plugin": "probe", "generation": uint64(1)}}, {"plugin-host-ended", map[string]any{"plugin": "probe", "generation": uint64(1)}}}) {
		t.Fatalf("events %v, want plugin-host-ended", *events)
	}
	// Another view.error reason is an error line that closes nothing.
	registerPluginHostChannel(s, "probe", nil)
	s.pluginHosts["probe"] = unsafe.Pointer(new(int))
	if err := s.pluginHostMessage("probe", hostMessage(`{"event": "view.error", "reason": "message without the sok marker"}`)); err == nil {
		t.Fatalf("a view.error without a queue overflow is no error")
	}
	if fake.closed != 1 {
		t.Fatalf("a view.error without a queue overflow closed the host: %d", fake.closed)
	}
}

// contract: plugin-host.channel.view-error-names-plugin
func TestPluginHostViewErrorNamesItsPluginOnce(t *testing.T) {
	for _, test := range []struct {
		name, reason, want string
	}{
		{"generic script error", "uncaught error: Script error.", "plugin probe: uncaught error: Script error."},
		{"matching prefix", "plugin probe: existing detail", "plugin probe: existing detail"},
		{"different plugin prefix", "plugin other: existing detail", "plugin probe: plugin other: existing detail"},
		{"queue overflow", "queue full for probe", "plugin probe: queue full for probe"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _ := channelSurfaces(t, &channelPlatform{}, true)
			message, err := json.Marshal(map[string]any{"event": "view.error", "reason": test.reason})
			if err != nil {
				t.Fatal(err)
			}
			got := s.pluginHostMessage("probe", hostMessage(string(message)))
			if got == nil || got.Error() != test.want {
				t.Fatalf("view.error: %v, want %q", got, test.want)
			}
		})
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
	if fake.closed != 1 || !reflect.DeepEqual(*events, []hostEvent{{"declared-ui-source-ended", map[string]any{"plugin": "probe", "generation": uint64(1)}}, {"plugin-host-ended", map[string]any{"plugin": "probe", "generation": uint64(1)}}}) {
		t.Fatalf("the process end closed %d and sent %v, want one close and plugin-host-ended", fake.closed, *events)
	}
	// The disposal on a removal of the plugin sends the event; the disposal of every host on a reload sends none.
	s.pluginHosts["probe"] = unsafe.Pointer(new(int))
	registerPluginHostChannel(s, "probe", nil)
	s.disposePluginHost("probe")
	if len(*events) != 4 || (*events)[2].name != "declared-ui-source-ended" || (*events)[3].name != "plugin-host-ended" {
		t.Fatalf("the disposal sent %v, want a second source end and plugin-host-ended", *events)
	}
	s.pluginHosts["probe"] = unsafe.Pointer(new(int))
	registerPluginHostChannel(s, "probe", nil)
	s.disposePluginHosts()
	if len(*events) != 4 {
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
	generation, _ := s.pluginHostChannels.generation("probe")
	if err := s.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", Generation: generation, ID: 7, Result: json.RawMessage(`1`)}); err != nil {
		t.Fatalf("reply post: %v", err)
	}
	if err := s.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", Generation: generation, ID: 8, Error: &ViewReplyError{Code: -32000, Message: "refused"}}); err != nil {
		t.Fatalf("error reply post: %v", err)
	}
	if disposition, err := s.pushPluginHostRequest(PluginHostRequestRequest{Plugin: "probe", Generation: generation, ID: 9, Command: "declared-ui.snapshot.request", Params: json.RawMessage(`{"status":"x"}`)}); err != nil || disposition != nil {
		t.Fatalf("request post: %v", err)
	}
	if accepted, err := s.pushPluginHostEvent(PluginHostEventRequest{Plugin: "probe", Generation: generation, Event: "declared-ui.snapshot.ack", Data: json.RawMessage(`{"plugin":"probe","status":"x","seq":1}`)}); err != nil || !accepted {
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
			return empty.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", Generation: 1, ID: 7, Result: json.RawMessage(`1`)})
		},
		func() error {
			_, err := empty.pushPluginHostRequest(PluginHostRequestRequest{Plugin: "probe", Generation: 1, ID: 8, Command: "x"})
			return err
		},
		func() error {
			_, err := empty.pushPluginHostEvent(PluginHostEventRequest{Plugin: "probe", Generation: 1, Event: "x", Data: json.RawMessage(`1`)})
			return err
		},
	} {
		if err := post(); err == nil || err.Error() != "plugin probe has no ready document" {
			t.Fatalf("post without a ready document: err %v", err)
		}
	}
	// A reply with neither a result nor an error, a request without a command, and an event without a name are refused.
	for _, post := range []func() error{
		func() error {
			return s.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", Generation: generation, ID: 7})
		},
		func() error {
			_, err := s.pushPluginHostRequest(PluginHostRequestRequest{Plugin: "probe", Generation: generation, ID: 8})
			return err
		},
		func() error {
			_, err := s.pushPluginHostEvent(PluginHostEventRequest{Plugin: "probe", Data: json.RawMessage(`1`)})
			return err
		},
	} {
		if err := post(); err == nil {
			t.Fatalf("an invalid post of the main page is accepted")
		}
	}
}

// contract: plugin-host.declared-ui.expanded
func TestPluginHostEventPostsDeclaredUIExpansion(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, true)
	generation, _ := s.pluginHostChannels.generation("probe")
	data := json.RawMessage(`{"status":"tree-status","tree":"example-tree","path":["root","child"],"expanded":true}`)
	if accepted, err := s.pushPluginHostEvent(PluginHostEventRequest{Plugin: "probe", Generation: generation, Event: "declared-ui.expanded", Data: data}); err != nil || !accepted {
		t.Fatalf("declared UI expansion post: %v", err)
	}
	want := []string{`{"data":{"status":"tree-status","tree":"example-tree","path":["root","child"],"expanded":true},"event":"declared-ui.expanded","sok":1}`}
	if !reflect.DeepEqual(fake.posted, want) {
		t.Fatalf("posted %v, want %v", fake.posted, want)
	}
}

// contract: plugin-host.declared-ui.source-generation
func TestPluginHostCommandsRejectAStaleGenerationAndAcceptTheCurrentOne(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, true)
	oldGeneration, _ := s.pluginHostChannels.generation("probe")
	currentGeneration, err := s.sourceOriginState().create("probe", false)
	if err != nil {
		t.Fatal(err)
	}
	s.pluginHostChannels.register("probe", nil, currentGeneration)
	s.pluginHostChannels.setReadyDocument("probe", "doc-2")
	ack := PluginHostEventRequest{Plugin: "probe", Generation: oldGeneration, Event: "declared-ui.snapshot.ack", Data: json.RawMessage(`{"plugin":"probe","status":"lines","seq":1}`)}
	if accepted, err := s.pushPluginHostEvent(ack); err != nil || accepted {
		t.Fatalf("stale snapshot ACK: accepted=%v err=%v, want a normal stale cancellation", accepted, err)
	}
	cancel, err := s.pushPluginHostRequest(PluginHostRequestRequest{Plugin: "probe", Generation: oldGeneration, ID: 1, Command: "declared-ui.snapshot.request", Params: json.RawMessage(`{"status":"lines"}`)})
	if err != nil || !reflect.DeepEqual(cancel, map[string]any{"cancelled": true, "sourceGeneration": oldGeneration}) {
		t.Fatalf("stale pull disposition %v, err %v", cancel, err)
	}
	if len(fake.posted) != 0 {
		t.Fatalf("stale ACK or pull reached the replacement provider: %v", fake.posted)
	}
	ack.Generation = currentGeneration
	if accepted, err := s.pushPluginHostEvent(ack); err != nil || !accepted {
		t.Fatalf("current snapshot ACK: accepted=%v err=%v", accepted, err)
	}
	result, err := s.pushPluginHostRequest(PluginHostRequestRequest{Plugin: "probe", Generation: currentGeneration, ID: 2, Command: "declared-ui.snapshot.request", Params: json.RawMessage(`{"status":"lines"}`)})
	if err != nil || result != nil {
		t.Fatalf("current pull result %v, err %v", result, err)
	}
	want := []string{
		`{"data":{"plugin":"probe","status":"lines","seq":1},"event":"declared-ui.snapshot.ack","sok":1}`,
		`{"command":"declared-ui.snapshot.request","id":2,"params":{"status":"lines"},"sok":1}`,
	}
	if !reflect.DeepEqual(fake.posted, want) {
		t.Fatalf("current-generation posts %v, want %v", fake.posted, want)
	}
}

// stateSurfaces returns the Surfaces of channelSurfaces whose host of plugin probe declares state, when declared is not
// nil, and has the ready document "doc-1".
func stateSurfaces(t *testing.T, fake uiFake, declared *hostState) *Surfaces {
	t.Helper()
	s, _ := channelSurfaces(t, fake, false)
	registerPluginHostChannel(s, "probe", declared)
	s.pluginHostChannels.setReadyDocument("probe", "doc-1")
	return s
}

// stateCall sends the state call command with params as the call request id of the host page of probe and returns the
// host message that the host posted for it.
func stateCall(t *testing.T, s *Surfaces, fake *channelPlatform, id int, command, params string) string {
	t.Helper()
	before := len(fake.posted)
	message := fmt.Sprintf(`{"id": %d, "command": %q, "params": %s}`, id, command, params)
	if err := s.pluginHostMessage("probe", hostMessage(message)); err != nil {
		t.Fatalf("state call %s: %v", message, err)
	}
	if len(fake.posted) != before+1 {
		t.Fatalf("state call %s posted %v, want one reply", message, fake.posted[before:])
	}
	return fake.posted[before]
}

// contract: plugin-host.state.calls
func TestPluginHostStateWriteAndReadKeepOneValuePerPlugin(t *testing.T) {
	fake := &channelPlatform{}
	s := stateSurfaces(t, fake, &hostState{format: 1, maxBytes: 64})
	if got, want := stateCall(t, s, fake, 1, "state.read", "null"), `{"id":1,"result":{"value":null},"sok":1}`; got != want {
		t.Fatalf("read without a saved value posted %s, want %s", got, want)
	}
	if got, want := stateCall(t, s, fake, 2, "state.write", `{"value": {"n": 1}}`), `{"id":2,"result":null,"sok":1}`; got != want {
		t.Fatalf("write posted %s, want %s", got, want)
	}
	if got, want := stateCall(t, s, fake, 3, "state.read", "null"), `{"id":3,"result":{"value":{"n":1}},"sok":1}`; got != want {
		t.Fatalf("read after the write posted %s, want %s", got, want)
	}
	// The host page of another window reads and replaces the same value of the plugin, and no state call reaches the main
	// page. The platform is one global of the process, so both windows post through fake.
	second := stateSurfaces(t, fake, &hostState{format: 1, maxBytes: 64})
	second.pluginHostStates = s.pluginHostStates
	if got, want := stateCall(t, second, fake, 4, "state.read", "null"), `{"id":4,"result":{"value":{"n":1}},"sok":1}`; got != want {
		t.Fatalf("read of another window posted %s, want %s", got, want)
	}
	stateCall(t, second, fake, 5, "state.write", `{"value": [2]}`)
	if got, want := stateCall(t, s, fake, 6, "state.read", "null"), `{"id":6,"result":{"value":[2]},"sok":1}`; got != want {
		t.Fatalf("read after the write of another window posted %s, want %s", got, want)
	}
	if calls := s.pluginHostChannels.openCalls("probe"); len(calls) != 0 {
		t.Fatalf("state calls are open: %v", calls)
	}
}

// contract: plugin-host.state.refusals
func TestPluginHostStateRefusesWithoutDeclarationOverTheLimitAndAnotherFormat(t *testing.T) {
	refusal := func(id int, message string) string {
		return fmt.Sprintf(`{"error":{"code":-32000,"message":%q},"id":%d,"sok":1}`, message, id)
	}
	fake := &channelPlatform{}
	undeclared := stateSurfaces(t, fake, nil)
	for id, command := range []string{"state.read", "state.write"} {
		if got, want := stateCall(t, undeclared, fake, id+1, command, `{"value": 1}`), refusal(id+1, "plugin probe declares no host state"); got != want {
			t.Fatalf("%s without a declared state posted %s, want %s", command, got, want)
		}
	}
	s := stateSurfaces(t, fake, &hostState{format: 1, maxBytes: 8})
	if got, want := stateCall(t, s, fake, 3, "state.write", `{"value": "123456789"}`), refusal(3, "plugin probe state of 11 bytes exceeds 8"); got != want {
		t.Fatalf("write over the limit posted %s, want %s", got, want)
	}
	for id, params := range []string{"null", `{"other": 1}`, "[1]"} {
		if got, want := stateCall(t, s, fake, 4+id, "state.write", params), refusal(4+id, "plugin probe state.write has no value"); got != want {
			t.Fatalf("write with params %s posted %s, want %s", params, got, want)
		}
	}
	if got := stateCall(t, s, fake, 7, "state.read", "null"); got != `{"id":7,"result":{"value":null},"sok":1}` {
		t.Fatalf("a refused write saved a value: %s", got)
	}
	// A value saved with format 1 is refused to a host that declares format 2 after an update of the plugin.
	stateCall(t, s, fake, 8, "state.write", `{"value": 5}`)
	registerPluginHostChannel(s, "probe", &hostState{format: 2, maxBytes: 8})
	s.pluginHostChannels.setReadyDocument("probe", "doc-1")
	if got, want := stateCall(t, s, fake, 9, "state.read", "null"), refusal(9, "plugin probe state format 1 is not 2"); got != want {
		t.Fatalf("read of another format posted %s, want %s", got, want)
	}
}

// contract: plugin-host.state.removal
func TestPluginHostStateEndsWithTheRemovalOrDisableOfThePlugin(t *testing.T) {
	fake := &channelPlatform{}
	s := stateSurfaces(t, fake, &hostState{format: 1, maxBytes: 64})
	empty := func(id int) string { return fmt.Sprintf(`{"id":%d,"result":{"value":null},"sok":1}`, id) }
	stateCall(t, s, fake, 1, "state.write", `{"value": 1}`)
	s.pluginHostStates.pluginChanged("update", "probe")
	s.pluginHostStates.pluginChanged("remove", "other")
	if got := stateCall(t, s, fake, 2, "state.read", "null"); got != `{"id":2,"result":{"value":1},"sok":1}` {
		t.Fatalf("an update or the removal of another plugin dropped the value: %s", got)
	}
	for id, action := range []string{"remove", "disable"} {
		stateCall(t, s, fake, 10+id, "state.write", `{"value": 1}`)
		s.pluginHostStates.pluginChanged(action, "probe")
		if got := stateCall(t, s, fake, 20+id, "state.read", "null"); got != empty(20+id) {
			t.Fatalf("the %s of the plugin kept the value: %s", action, got)
		}
	}
}

// contract: plugin-host.call.refuses-unlisted-commands
func TestPluginHostChannelRefusesEveryCommandOutsideTheAllowlist(t *testing.T) {
	// The plugin allowlist is the exposure reply and the region calls of a view. The names are fixtures of this check.
	// Every other method of the Wails command table (the exported methods of Host) is refused by the channel of a plugin
	// host page.
	allowed := map[string]bool{}
	for _, name := range []string{
		"exposureReply",
		"compositionDeclare", "compositionPlace",
		"documentAttach", "documentLoad", "documentZoom", "documentGo", "documentDetach", "documentSubscribe", "documentUnsubscribe",
		"documentPost", "documentQuery", "documentInteractionState",
		"imageAttach", "imageFocus", "imageCaret", "imageText", "imageDetach",
	} {
		allowed[name] = true
	}
	fake := &channelPlatform{}
	s, events := channelSurfaces(t, fake, true)
	table := reflect.TypeOf(&Host{})
	checked := 0
	for i := 0; i < table.NumMethod(); i++ {
		name := table.Method(i).Name
		command := strings.ToLower(name[:1]) + name[1:]
		if allowed[command] {
			continue
		}
		checked++
		if err := s.pluginHostMessage("probe", hostMessage(`{"id": 9, "command": "`+command+`"}`)); err != nil {
			t.Fatalf("command %s: %v", command, err)
		}
		want := `{"error":{"code":-32000,"message":"plugin host call ` + command + ` is not served"},"id":9,"sok":1}`
		if len(fake.posted) == 0 || fake.posted[len(fake.posted)-1] != want {
			t.Fatalf("command %s posted %v, want the refusal %s", command, fake.posted, want)
		}
	}
	if checked == 0 {
		t.Fatal("the command table has no command outside the allowlist")
	}
	if len(*events) != 0 {
		t.Fatalf("a refused command was forwarded: %v", *events)
	}
}

// contract: plugin-host.channel.ui-thread
func TestPluginHostPostsRunOnTheUIThread(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, false)
	ready := hostMessage(`{"event": "view.ready", "plugin": "probe", "document": "doc-1"}`)
	if err := s.pluginHostMessage("probe", ready); err != nil {
		t.Fatalf("ready: %v", err)
	}
	// A theme change comes from the binding of the main page, which runs outside the UI thread.
	s.postThemeToPluginHosts()
	if len(fake.postedOnUI) != 3 {
		t.Fatalf("posts %d, want the theme, current project, and theme change", len(fake.postedOnUI))
	}
	for i, onUI := range fake.postedOnUI {
		if !onUI {
			t.Fatalf("post %d reached the native document outside a UI-thread task", i)
		}
	}
}

// contract: view.channel.ui-thread
func TestViewPostsRunOnTheUIThread(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	ready := `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1","page":"1234.5"}}`
	if err := s.viewMessage("probe-surface", ready); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	// A theme change comes from the binding of the main page, which runs outside the UI thread.
	s.postThemeToViews()
	if len(fake.postedOnUI) != 2 {
		t.Fatalf("posts %d, want the theme after ready and the theme change", len(fake.postedOnUI))
	}
	for i, onUI := range fake.postedOnUI {
		if !onUI {
			t.Fatalf("post %d reached the native document outside a UI-thread task", i)
		}
	}
}

// contract: plugin-host.project.post
// A change of the project that the window shows is sent to each plugin host with a ready document as the event project, with the
// id and the root of the project or null, as the theme is sent (docs/spec/plugin-host.md#configuration).
func TestPluginHostChannelPostsTheProjectChangeAsAnEvent(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, false)
	if err := s.pluginHostMessage("probe", hostMessage(`{"event": "view.ready", "plugin": "probe", "document": "doc-1"}`)); err != nil {
		t.Fatalf("ready: %v", err)
	}
	fake.posted = nil
	s.shown = "prj-two"
	s.root = "/work/two"
	s.postProjectToPluginHosts()
	if len(fake.posted) != 1 || !strings.Contains(fake.posted[0], `"event":"project"`) || !strings.Contains(fake.posted[0], `"data":{"id":"prj-two","root":"/work/two"}`) {
		t.Fatalf("posted %v, want one project event with the id prj-two and the root /work/two", fake.posted)
	}
	fake.posted = nil
	s.shown = ""
	s.root = ""
	s.postProjectToPluginHosts()
	if len(fake.posted) != 1 || !strings.Contains(fake.posted[0], `"data":null`) || !strings.Contains(fake.posted[0], `"event":"project"`) {
		t.Fatalf("posted %v, want one project event with null", fake.posted)
	}
}

// contract: plugin-host.project.post
// A project change while the host document is unready is sent after the document reports ready.
func TestPluginHostReadyReceivesTheProjectCurrentlyShown(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, false)
	s.shown = "prj-old"
	s.root = "/work/old"
	// The project release occurs while the host document has no ready receiver.
	s.shown = ""
	s.root = ""
	s.postProjectToPluginHosts()
	if len(fake.posted) != 0 {
		t.Fatalf("an unready host received %v", fake.posted)
	}

	if err := s.pluginHostMessage("probe", hostMessage(`{"event": "view.ready", "plugin": "probe", "document": "doc-1"}`)); err != nil {
		t.Fatalf("ready: %v", err)
	}
	if len(fake.posted) != 2 || !strings.Contains(fake.posted[0], `"event":"theme"`) ||
		!strings.Contains(fake.posted[1], `"event":"project"`) || !strings.Contains(fake.posted[1], `"data":null`) {
		t.Fatalf("ready posts %v, want current theme then current null project", fake.posted)
	}
}

// contract: plugin-host.channel.reply-null-result
func TestPluginHostReplyWithANullResultPostsTheNullResult(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, true)
	req, err := argument[PluginHostReplyRequest]("request", json.RawMessage(`{"plugin":"probe","generation":1,"id":1,"result":null}`))
	if err != nil {
		t.Fatalf("reply with a null result: %v", err)
	}
	if err := s.answerPluginHostCall(req); err != nil {
		t.Fatalf("reply with a null result is refused: %v", err)
	}
	if len(fake.posted) == 0 || !strings.Contains(fake.posted[len(fake.posted)-1], `"result":null`) {
		t.Fatalf("posted %v, want the null result", fake.posted)
	}
}

// contract: plugin-host.channel.reply-generation-scoped-cleanup
func TestPluginHostReplyDoesNotCloseACallOfAReplacementGeneration(t *testing.T) {
	platform := &replacePluginHostOnPost{channelPlatform: &channelPlatform{}}
	s, _ := channelSurfaces(t, platform, true)
	oldGeneration, _ := s.pluginHostChannels.generation("probe")
	s.pluginHostChannels.trackCall("probe", 7, "old.command")
	var replacement uint64
	platform.afterPost = func() {
		platform.afterPost = nil
		if !s.sourceOriginState().retire("probe", false, oldGeneration) {
			t.Fatal("the old source generation was not current before replacement")
		}
		var err error
		replacement, err = s.sourceOriginState().create("probe", false)
		if err != nil {
			t.Fatalf("create replacement source: %v", err)
		}
		channel := s.pluginHostChannels.register("probe", nil, replacement)
		channel.document = "doc-2"
		channel.calls[7] = "replacement.command"
		s.mu.Lock()
		s.pluginHosts["probe"] = unsafe.Pointer(new(int))
		s.mu.Unlock()
	}
	if err := s.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", Generation: oldGeneration, ID: 7, Result: json.RawMessage(`null`)}); err != nil {
		t.Fatalf("answer old call: %v", err)
	}
	if replacement == 0 {
		t.Fatal("posting the old answer did not create the controlled replacement")
	}
	if calls := s.pluginHostChannels.openCalls("probe"); !reflect.DeepEqual(calls, []string{"replacement.command"}) {
		t.Fatalf("open calls after the old reply: %v, want the replacement call", calls)
	}
}

// contract: plugin-host.source-generation
func TestPluginHostCommandsRefuseGenerationsAboveTheJavaScriptSafeIntegerLimit(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, true)
	unsafeGeneration := maxSourceGeneration + 1
	if err := s.answerPluginHostCall(PluginHostReplyRequest{Plugin: "probe", Generation: unsafeGeneration, ID: 1, Result: json.RawMessage(`null`)}); err == nil || !strings.Contains(err.Error(), "exceeds JavaScript safe integer maximum") {
		t.Fatalf("reply with unsafe generation returned %v", err)
	}
	if _, err := s.pushPluginHostRequest(PluginHostRequestRequest{Plugin: "probe", Generation: unsafeGeneration, ID: 2, Command: "declared-ui.snapshot.request"}); err == nil || !strings.Contains(err.Error(), "exceeds JavaScript safe integer maximum") {
		t.Fatalf("request with unsafe generation returned %v", err)
	}
	if _, err := s.pushPluginHostEvent(PluginHostEventRequest{Plugin: "probe", Generation: unsafeGeneration, Event: "declared-ui.snapshot.ack", Data: json.RawMessage(`{"plugin":"probe","status":"lines","seq":1}`)}); err == nil || !strings.Contains(err.Error(), "exceeds JavaScript safe integer maximum") {
		t.Fatalf("event with unsafe generation returned %v", err)
	}
	if len(fake.posted) != 0 {
		t.Fatalf("a command with an unsafe generation reached the provider: %v", fake.posted)
	}
}

// contract: plugin-host.channel.end-of-closed-window-is-not-an-error
func TestPluginHostEndOfAClosedHostIsNotCountedAsAFailure(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, true)
	handle := unsafe.Pointer(new(int))
	s.pluginHosts["probe"] = handle
	// The close of the window removed the host before its process ended.
	delete(s.pluginHosts, "probe")
	s.pluginHostEnded("probe", handle)
	if attempt, _ := s.pluginHostRestarts.failed("probe"); attempt != 1 {
		t.Fatalf("the end of a closed host was counted as a failure: attempt %d, want 1", attempt)
	}
}

// contract: host.window.close-keeps-plugin-host-records
func TestClosingWindowDisposesEveryPluginHostItHolds(t *testing.T) {
	fake := &closingPlatform{}
	s, _ := channelSurfaces(t, fake, true)
	s.pluginHosts["other"] = unsafe.Pointer(new(int))
	// The close step runs with the hosts the window holds; it closes each of them once.
	s.disposePluginHosts()
	if fake.closed != 2 {
		t.Fatalf("the close step closed %d host web views, want the 2 that the window held", fake.closed)
	}
	if len(s.pluginHosts) != 0 {
		t.Fatalf("the window still records %d plugin hosts after its close", len(s.pluginHosts))
	}
}

// contract: plugin-host.channel.late-state-of-closed-window-is-not-an-error
func TestLateStateOfAClosedHostCreatesNoChannel(t *testing.T) {
	fake := &channelPlatform{}
	s, _ := channelSurfaces(t, fake, false)
	// The close of the window unregisters the channel of its host; a state that arrives later records nothing.
	s.pluginHostChannels.unregister("probe")
	s.pluginHostState("probe", pluginHostNavigationState(true, 1))
	if _, ok := s.pluginHostChannels.channel("probe"); ok {
		t.Fatalf("a late state created a channel of a closed host")
	}
}
