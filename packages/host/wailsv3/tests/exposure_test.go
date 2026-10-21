package host_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"slices"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: exposure.list.appends-host-entries-registered
func TestExposureListAppendsHostEntries(t *testing.T) {
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	got := call(t, conn, 1, "exposure.list", map[string]any{"window": "main"})
	var list struct {
		Status []struct {
			Name       string
			Registered bool
		}
		Commands []struct {
			Name       string
			Registered bool
		}
	}
	if err := json.Unmarshal(got.Result, &list); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, entry := range append(list.Status, list.Commands...) {
		names[entry.Name] = entry.Registered
	}
	for _, name := range []string{"core.layout", "host.buttons", "host.log", "host.window", "host.windows", "host.screens", "host.dock", "host.window.close", "host.window.fullscreen", "host.window.move", "host.dock.select", "host.hit", "host.quit"} {
		if !names[name] {
			t.Fatalf("%s is missing or unregistered in %s", name, got.Result)
		}
	}
}

// contract: exposure.list.host-entries-exact-sorted-set, exposure.list.host-entries-described, exposure.list.host-quit-result-null
func TestExposureListHostEntriesAreSortedAndDescribed(t *testing.T) {
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	got := call(t, conn, 1, "exposure.list", map[string]any{"window": "main"})
	type entry struct {
		Name        string
		Description string
		Registered  bool
		Result      json.RawMessage
	}
	var list struct{ Status, Commands []entry }
	if err := json.Unmarshal(got.Result, &list); err != nil {
		t.Fatal(err)
	}
	names := func(entries []entry) []string {
		out := make([]string, 0, len(entries))
		for _, e := range entries {
			out = append(out, e.Name)
		}
		return out
	}
	status := []string{"core.layout", "host.buttons", "host.dock", "host.log", "host.menu", "host.screens", "host.sidecars", "host.window", "host.windows"}
	if !slices.Equal(names(list.Status), status) {
		t.Fatalf("status %v, want %v", names(list.Status), status)
	}
	commands := []string{
		"host.dock.select",
		"host.hit",
		"host.menu.select",
		"host.quit",
		"host.window.close",
		"host.window.fullscreen",
		"host.window.maximize",
		"host.window.move",
		"host.window.presented",
		"host.window.reload",
		"host.window.resize",
	}
	if !slices.Equal(names(list.Commands), commands) {
		t.Fatalf("commands %v, want %v", names(list.Commands), commands)
	}
	// The first status entries are page entries, so only the descriptions of the host entries are checked.
	for _, e := range append(list.Status[1:], list.Commands...) {
		if !e.Registered || e.Description == "" {
			t.Fatalf("%s: registered %v, description %q", e.Name, e.Registered, e.Description)
		}
	}
	quit := list.Commands[slices.IndexFunc(list.Commands, func(e entry) bool { return e.Name == "host.quit" })]
	if string(quit.Result) != `{"type":"null"}` {
		t.Fatalf("host.quit result %s", quit.Result)
	}
}

// listBackend is a fakeBackend that converts the exposure.list reply of the page to reply.
type listBackend struct {
	*fakeBackend
	reply json.RawMessage
}

func (b listBackend) PageRequest(window, method string, params json.RawMessage) (json.RawMessage, error) {
	if method == "exposure.list" {
		return b.reply, nil
	}
	return b.fakeBackend.PageRequest(window, method, params)
}

// contract: exposure.list.non-object-list-rejected
func TestExposureListRejectsANonObjectPageList(t *testing.T) {
	for _, reply := range []string{`[]`, `null`, `3`, `"list"`} {
		_, address, _ := serve(t, listBackend{fakeBackend: newFakeBackend(), reply: json.RawMessage(reply)})
		conn := dial(t, address)
		got := call(t, conn, 1, "exposure.list", map[string]any{"window": "main"})
		if got.Error == nil || got.Error.Code != -32603 {
			t.Fatalf("page list %s: result %s, error %v", reply, got.Result, got.Error)
		}
	}
}

// contract: exposure.timeout.command-run-default-and-declared, exposure.timeout.status-next-unbounded, exposure.timeout.invalid-timeout-rejected, exposure.timeout.status-next-timeout-rejected
func TestForwardedRequestsUseTheDeclaredTimeout(t *testing.T) {
	cases := []struct {
		method, timeout string
		want            time.Duration
	}{
		{"command.run", "", 10 * time.Second},
		{"command.run", "600000", 600 * time.Second},
		{"command.run", "1", time.Millisecond},
		{"status.next", "", 0},
	}
	for _, c := range cases {
		got, invalid := host.ForwardTimeout(c.method, json.RawMessage(c.timeout))
		if invalid != nil || got != c.want {
			t.Fatalf("%s %q: %v %v, want %v", c.method, c.timeout, got, invalid, c.want)
		}
	}
	for _, timeout := range []string{"0", "600001", "1.5", `"10"`, "-1"} {
		if _, invalid := host.ForwardTimeout("command.run", json.RawMessage(timeout)); invalid == nil || invalid.Code != -32602 {
			t.Fatalf("timeout %s: %v", timeout, invalid)
		}
	}
	if _, invalid := host.ForwardTimeout("status.next", json.RawMessage("10")); invalid == nil || invalid.Code != -32602 {
		t.Fatalf("status.next accepted a timeout: %v", invalid)
	}
}

// relayWait is the time that the relay tests wait for a reply.
const relayWait = 5 * time.Second

// contract: exposure.relay.reply-resolves-request
func TestRelayReplyFromTheTargetDocumentResolvesTheRequest(t *testing.T) {
	relay := host.NewRelay[string]()
	got := relay.Request("main", relayWait, func(id uint64) error {
		go func() {
			if err := relay.Resolve(id, "main", host.ExposureResult{Result: json.RawMessage(`{"ok":true}`)}); err != nil {
				t.Error(err)
			}
		}()
		return nil
	})
	if got.Error != nil || string(got.Result) != `{"ok":true}` {
		t.Fatalf("reply %+v", got)
	}
}

// contract: exposure.relay.keeps-value-text
func TestRelayReplyKeepsTheTextAndKeyOrderOfThePageValue(t *testing.T) {
	relay := host.NewRelay[string]()
	value := `{"zeta":1,"alpha":{"b":2,"a":1}}`
	got := relay.Request("main", relayWait, func(id uint64) error {
		return relay.Resolve(id, "main", host.ExposureResult{Result: json.RawMessage(value)})
	})
	if got.Error != nil || string(got.Result) != value {
		t.Fatalf("reply %+v, want %s", got, value)
	}
}

// contract: exposure.relay.missing-result-is-null
func TestRelayReplyWithoutResultIsNull(t *testing.T) {
	relay := host.NewRelay[string]()
	got := relay.Request("main", relayWait, func(id uint64) error {
		return relay.Resolve(id, "main", host.ExposureResult{})
	})
	if got.Error != nil || len(got.Result) != 0 {
		t.Fatalf("reply %+v, want an empty result", got)
	}
}

// contract: exposure.relay.error-reply-keeps-code-and-message
func TestRelayErrorReplyKeepsCodeAndMessage(t *testing.T) {
	relay := host.NewRelay[string]()
	got := relay.Request("main", relayWait, func(id uint64) error {
		return relay.Resolve(id, "main", host.ExposureResult{Error: &host.RPCError{Code: 1002, Message: "not registered"}})
	})
	if got.Error == nil || got.Error.Code != 1002 || got.Error.Message != "not registered" {
		t.Fatalf("reply %+v", got)
	}
}

// contract: exposure.relay.foreign-document-reply-ignored-timeout-1005
func TestRelayReplyFromAnotherDocumentIsRejectedAndTheRequestTimesOut(t *testing.T) {
	relay := host.NewRelay[string]()
	var requested uint64
	got := relay.Request("main", 50*time.Millisecond, func(id uint64) error {
		requested = id
		if err := relay.Resolve(id, "surface-main-a", host.ExposureResult{Result: json.RawMessage(`1`)}); err == nil {
			t.Error("a reply from another document was accepted")
		}
		return nil
	})
	if got.Error == nil || got.Error.Code != 1005 {
		t.Fatalf("reply %+v, want 1005", got)
	}
	if err := relay.Resolve(requested, "main", host.ExposureResult{Result: json.RawMessage(`1`)}); err == nil {
		t.Fatal("a late reply was accepted after the timeout")
	}
}

// contract: exposure.relay.late-reply-states-its-delay
func TestRelayLateReplyStatesItsDelay(t *testing.T) {
	relay := host.NewRelay[string]()
	var requested uint64
	got := relay.Request("main", 50*time.Millisecond, func(id uint64) error {
		requested = id
		return nil
	})
	if got.Error == nil || got.Error.Code != 1005 || got.Error.Message != "the document did not reply within 50 ms" {
		t.Fatalf("reply %+v, want 1005 with the timeout in milliseconds", got.Error)
	}
	err := relay.Resolve(requested, "main", host.ExposureResult{Result: json.RawMessage(`1`)})
	if err == nil || !regexp.MustCompile(fmt.Sprintf(`^exposure reply %d arrived \d+ ms after it was sent; its request timed out after 50 ms$`, requested)).MatchString(err.Error()) {
		t.Fatalf("late reply = %v", err)
	}
	if err := relay.Resolve(requested+100, "main", host.ExposureResult{Result: json.RawMessage(`1`)}); err == nil || err.Error() != fmt.Sprintf("exposure reply %d has no matching request", requested+100) {
		t.Fatalf("reply to no request = %v", err)
	}
}

// contract: exposure.relay.send-failure-1003
func TestRelaySendFailureIsReportedWithoutWaiting(t *testing.T) {
	relay := host.NewRelay[string]()
	started := time.Now()
	got := relay.Request("main", relayWait, func(uint64) error { return errors.New("webview is gone") })
	if got.Error == nil || got.Error.Code != 1003 {
		t.Fatalf("reply %+v, want 1003", got)
	}
	if elapsed := time.Since(started); elapsed >= relayWait {
		t.Fatalf("the failed send waited %s", elapsed)
	}
}

// contract: exposure.relay.closed-document-fails-pending-1003
func TestRelayClosedDocumentFailsItsPendingRequests(t *testing.T) {
	relay := host.NewRelay[string]()
	got := relay.Request("main", relayWait, func(uint64) error {
		relay.Abandon(func(target string) bool { return target == "main" })
		return nil
	})
	if got.Error == nil || got.Error.Code != 1003 {
		t.Fatalf("reply %+v, want 1003", got)
	}
}

// contract: exposure.relay.no-timeout-waits-until-close
func TestRelayRequestWithoutTimeoutWaitsUntilTheDocumentCloses(t *testing.T) {
	relay := host.NewRelay[string]()
	got := relay.Request("surface-main-a", 0, func(uint64) error {
		// After the wait for the reply started, another goroutine announces that the document ended.
		go relay.Abandon(func(target string) bool { return target == "surface-main-a" })
		return nil
	})
	if got.Error == nil || got.Error.Code != 1003 {
		t.Fatalf("reply %+v, want 1003", got)
	}
}

// contract: exposure.status-change.refuses-host-name
func TestPageStatusChangeRefusesHostName(t *testing.T) {
	if err := host.CheckPageStatusChange("host.window"); err == nil || err.Error() != "the page cannot change host status host.window" {
		t.Fatalf("host.window: %v", err)
	}
	if err := host.CheckPageStatusChange("core.grid"); err != nil {
		t.Fatalf("core.grid: %v", err)
	}
}

// callEvents flushes the writer and returns the fields of the events named event that it stored.
func callEvents(t *testing.T, log *host.EventLog, event string) []map[string]any {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var fields []map[string]any
	for _, record := range readEventLog(t, log.Path()) {
		if record["event"] == event {
			fields = append(fields, record["fields"].(map[string]any))
		}
	}
	return fields
}

// contract: exposure.relay.timeout-writes-call-event
func TestRelayTimeoutOfACommandWritesCallTimeout(t *testing.T) {
	log := useRoomyEventLog(t)
	relay := host.NewRelay[string]()
	got := relay.RequestCall("surface-main-a", host.RelayCall{Plugin: "probe", Command: "probe.run"}, 50*time.Millisecond, func(uint64) error { return nil })
	if got.Error == nil || got.Error.Code != 1005 {
		t.Fatalf("reply %+v, want 1005", got)
	}
	if want := []map[string]any{{"plugin": "probe", "command": "probe.run"}}; !reflect.DeepEqual(callEvents(t, log, "host.call.timeout"), want) {
		t.Fatalf("host.call.timeout = %v, want %v", callEvents(t, log, "host.call.timeout"), want)
	}
	// A request that is not a command writes no call event.
	relay.Request("main", 50*time.Millisecond, func(uint64) error { return nil })
	if got := callEvents(t, log, "host.call.timeout"); len(got) != 1 {
		t.Fatalf("host.call.timeout has %d events after a request that is not a command, want 1", len(got))
	}
}

// contract: exposure.relay.late-reply-writes-call-event
func TestRelayLateReplyOfACommandWritesCallLateReply(t *testing.T) {
	log := useRoomyEventLog(t)
	relay := host.NewRelay[string]()
	var requested uint64
	relay.RequestCall("surface-main-a", host.RelayCall{Plugin: "probe", Command: "probe.run"}, 50*time.Millisecond, func(id uint64) error {
		requested = id
		return nil
	})
	if err := relay.Resolve(requested, "surface-main-a", host.ExposureResult{Result: json.RawMessage(`1`)}); err == nil {
		t.Fatal("a late reply was accepted after the timeout")
	}
	late := callEvents(t, log, "host.trace.call.late-reply")
	if len(late) != 1 || late[0]["plugin"] != "probe" || late[0]["command"] != "probe.run" {
		t.Fatalf("host.trace.call.late-reply = %v, want one event of plugin probe and command probe.run", late)
	}
	if delay, ok := late[0]["delay"].(float64); !ok || delay < 50 {
		t.Fatalf("delay = %v, want a number of at least 50 ms", late[0]["delay"])
	}
}

// contract: view.exposure.register
// The caller of a registration is either the page view of the surface itself or the main page of the window registering
// for a surface with a view (docs/spec/exposure.md#relay).
func TestRegistrationCallerAcceptsTheSurfacePageAndTheMainPageOfAView(t *testing.T) {
	if err := host.CheckRegistrationCaller("probe-surface", "probe-surface", false, false); err != nil {
		t.Fatalf("the page view of the surface: %v", err)
	}
	if err := host.CheckRegistrationCaller("other-surface", "probe-surface", false, true); err == nil || err.Error() != `this document is not surface "probe-surface"` {
		t.Fatalf("the page view of another surface: %v, want a surface mismatch error", err)
	}
	if err := host.CheckRegistrationCaller("", "probe-surface", true, true); err != nil {
		t.Fatalf("the main page for a surface with a view: %v", err)
	}
	if err := host.CheckRegistrationCaller("", "probe-surface", true, false); err == nil || err.Error() != `this document is not surface "probe-surface"` {
		t.Fatalf("the main page for a surface without a view: %v, want a surface mismatch error", err)
	}
	if err := host.CheckRegistrationCaller("", "probe-surface", false, true); err == nil || err.Error() != `this document is not surface "probe-surface"` {
		t.Fatalf("an unknown caller: %v, want a surface mismatch error", err)
	}
}
