package host_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// contract: exposure.list.appends-host-entries-registered
func TestExposureListAppendsHostEntries(t *testing.T) {
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	got := call(t, conn, 1, "exposure.list", map[string]any{"window": "main"})
	// The list keeps the members of the page's list: status, commands and element.
	var members map[string]json.RawMessage
	if err := json.Unmarshal(got.Result, &members); err != nil {
		t.Fatal(err)
	}
	if keys := slices.Sorted(maps.Keys(members)); !slices.Equal(keys, []string{"commands", "element", "status"}) || string(members["element"]) != "[]" {
		t.Fatalf("exposure.list members %v, element %s, want commands, element [] and status", keys, members["element"])
	}
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

// contract: exposure.list.host-owner-without-page
func TestExposureListOfTheHostOwnerDoesNotAskThePage(t *testing.T) {
	backend := newFakeBackend()
	backend.failures = map[string]error{"exposure.list": &host.RPCError{Code: 1003, Message: "the main page is not ready"}}
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	got := call(t, conn, 1, "exposure.list", map[string]any{"window": "main", "owner": "host"})
	if got.Error != nil {
		t.Fatalf("exposure.list of the host owner failed: %+v", got.Error)
	}
	// The host declares no element entry, so the host list holds an empty element.
	var members map[string]json.RawMessage
	if err := json.Unmarshal(got.Result, &members); err != nil {
		t.Fatal(err)
	}
	if keys := slices.Sorted(maps.Keys(members)); !slices.Equal(keys, []string{"commands", "element", "status"}) || string(members["element"]) != "[]" {
		t.Fatalf("host exposure.list members %v, element %s, want commands, element [] and status", keys, members["element"])
	}
	var list struct {
		Status, Commands []struct {
			Name       string
			Registered bool
		}
	}
	if err := json.Unmarshal(got.Result, &list); err != nil {
		t.Fatal(err)
	}
	quit := false
	for _, entry := range append(list.Status, list.Commands...) {
		if !strings.HasPrefix(entry.Name, "host.") || !entry.Registered {
			t.Fatalf("entry %s registered %v in the host list %s", entry.Name, entry.Registered, got.Result)
		}
		quit = quit || entry.Name == "host.quit"
	}
	if !quit {
		t.Fatalf("host.quit is missing from %s", got.Result)
	}
	backend.mu.Lock()
	asked := slices.Contains(backend.requests, "exposure.list")
	backend.mu.Unlock()
	if asked {
		t.Fatal("exposure.list of the host owner asked the page")
	}
	other := call(t, conn, 2, "exposure.list", map[string]any{"window": "main", "owner": "core"})
	if other.Error == nil || other.Error.Message != "exposure.list owner must be host" {
		t.Fatalf("exposure.list of another owner answered %+v", other)
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

// contract: exposure.list.host-hit-kinds
func TestHostHitDeclaresTheWorkbenchDocumentAndNativeKinds(t *testing.T) {
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	got := call(t, conn, 1, "exposure.list", map[string]any{"window": "main", "owner": "host"})
	type command struct {
		Name   string
		Result struct {
			Properties struct{ Kind struct{ Enum []string } }
		}
	}
	var list struct{ Commands []command }
	if err := json.Unmarshal(got.Result, &list); err != nil {
		t.Fatal(err)
	}
	at := slices.IndexFunc(list.Commands, func(e command) bool { return e.Name == "host.hit" })
	if at < 0 {
		t.Fatalf("host.hit is missing from %s", got.Result)
	}
	if kinds := list.Commands[at].Result.Properties.Kind.Enum; !slices.Equal(kinds, []string{"workbench", "document", "native"}) {
		t.Fatalf("host.hit kinds %v, want workbench, document and native", kinds)
	}
}

// listBackend is a fakeBackend that converts the exposure.list reply of the page to reply.
type listBackend struct {
	*fakeBackend
	reply json.RawMessage
}

func (b listBackend) PageRequest(ctx context.Context, window, method string, params json.RawMessage) (json.RawMessage, error) {
	if method == "exposure.list" {
		return b.reply, nil
	}
	return b.fakeBackend.PageRequest(ctx, window, method, params)
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

// A forwarded request has no time limit, so the request of the main page carries none: it ends by its reply or by the end
// of its peer.
// contract: exposure.command.ends-by-reply-or-peer-end
func TestAForwardedRequestCarriesNoTimeLimit(t *testing.T) {
	if field, found := reflect.TypeOf(host.ExposureForwardRequest{}).FieldByName("Timeout"); found {
		t.Fatalf("the forward request has the time limit member %s %s", field.Name, field.Tag)
	}
}

// relayRequest starts a request to target on relay and returns the channel of its result and the channel that receives its
// id when the relay sends it. The send is the event at which the request waits for its reply.
func relayRequest(relay *host.Relay[string], target string) (<-chan host.ExposureResult, <-chan uint64) {
	result := make(chan host.ExposureResult, 1)
	sent := make(chan uint64, 1)
	go func() {
		result <- relay.Request(target, func(id uint64) error {
			sent <- id
			return nil
		})
	}()
	return result, sent
}

// expectWaiting fails when result already holds the end of the request.
func expectWaiting(t *testing.T, result <-chan host.ExposureResult, what string) {
	t.Helper()
	select {
	case got := <-result:
		t.Fatalf("%s ended: %+v", what, got)
	default:
	}
}

// contract: exposure.relay.reply-resolves-request
func TestRelayReplyFromTheTargetDocumentResolvesTheRequest(t *testing.T) {
	relay := host.NewRelay[string]()
	got := relay.Request("main", func(id uint64) error {
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
	got := relay.Request("main", func(id uint64) error {
		return relay.Resolve(id, "main", host.ExposureResult{Result: json.RawMessage(value)})
	})
	if got.Error != nil || string(got.Result) != value {
		t.Fatalf("reply %+v, want %s", got, value)
	}
}

// contract: exposure.relay.missing-result-is-null
func TestRelayReplyWithoutResultIsNull(t *testing.T) {
	relay := host.NewRelay[string]()
	got := relay.Request("main", func(id uint64) error {
		return relay.Resolve(id, "main", host.ExposureResult{})
	})
	if got.Error != nil || len(got.Result) != 0 {
		t.Fatalf("reply %+v, want an empty result", got)
	}
}

// contract: exposure.relay.error-reply-keeps-code-and-message
func TestRelayErrorReplyKeepsCodeAndMessage(t *testing.T) {
	relay := host.NewRelay[string]()
	got := relay.Request("main", func(id uint64) error {
		return relay.Resolve(id, "main", host.ExposureResult{Error: &host.RPCError{Code: 1002, Message: "not registered"}})
	})
	if got.Error == nil || got.Error.Code != 1002 || got.Error.Message != "not registered" {
		t.Fatalf("reply %+v", got)
	}
}

// A reply from another document is refused and changes nothing: the request keeps waiting, and the reply of its document
// then ends it with that reply, not with the foreign one.
// contract: exposure.relay.foreign-document-reply-ignored
func TestRelayReplyFromAnotherDocumentIsIgnoredAndTheRequestKeepsWaiting(t *testing.T) {
	relay := host.NewRelay[string]()
	result, sent := relayRequest(relay, "main")
	id := <-sent
	if err := relay.Resolve(id, "surface-main-a", host.ExposureResult{Result: json.RawMessage(`1`)}); err == nil {
		t.Fatal("a reply from another document was accepted")
	}
	expectWaiting(t, result, "the request after a reply from another document")
	if err := relay.Resolve(id, "main", host.ExposureResult{Result: json.RawMessage(`2`)}); err != nil {
		t.Fatalf("the reply of the document of the request: %v", err)
	}
	if got := <-result; got.Error != nil || string(got.Result) != `2` {
		t.Fatalf("reply %+v, want the result 2 of the document of the request", got)
	}
}

// A request has no time limit: it waits until its document closes, then fails with 1003, and writes no call event on the
// way. A reply that comes after the close is an observation, and a reply to an id that the relay never sent fails.
// contract: exposure.relay.waits-until-reply-or-close
func TestRelayRequestWaitsUntilItsDocumentCloses(t *testing.T) {
	log := support.UseRoomyEventLog(t)
	support.TraceOn(t)
	relay := host.NewRelay[string]()
	result, sent := relayRequest(relay, "surface-main-a")
	id := <-sent
	expectWaiting(t, result, "the request before its document closed")
	relay.Abandon(func(target string) bool { return target == "surface-main-a" })
	if got := <-result; got.Error == nil || got.Error.Code != 1003 {
		t.Fatalf("reply %+v, want 1003", got)
	}
	if err := relay.Resolve(id, "surface-main-a", host.ExposureResult{Result: json.RawMessage(`1`)}); err != nil {
		t.Fatalf("the reply after the close = %v, want it accepted as an observation", err)
	}
	if err := relay.Resolve(id+100, "surface-main-a", host.ExposureResult{Result: json.RawMessage(`1`)}); err == nil ||
		err.Error() != fmt.Sprintf("exposure reply %d has no matching request", id+100) {
		t.Fatalf("reply to no request = %v", err)
	}
	for _, event := range []string{"host.call.timeout", "host.trace.call.late-reply"} {
		if got := callEvents(t, log, event); len(got) != 0 {
			t.Fatalf("%s = %v, want none", event, got)
		}
	}
}

// The end of the endpoint connection that sent a request ends it on the host. The reply of the document then comes to a
// request that ended: the host accepts it, writes the observation and answers nothing, with no delay and no call event.
// contract: exposure.relay.connection-end-ends-its-requests
func TestTheEndOfItsConnectionEndsARelayRequestAndItsReplyIsAnObservation(t *testing.T) {
	written := support.CaptureLog(t)
	support.TraceOn(t)
	relay := host.NewRelay[string]()
	result, sent := relayRequest(relay, "surface-main-a")
	id := <-sent
	expectWaiting(t, result, "the request before its connection ended")
	relay.End(id)
	if got := <-result; got.Error == nil {
		t.Fatalf("the request whose connection ended answered %+v, want no result", got)
	}
	if err := relay.Resolve(id, "surface-main-a", host.ExposureResult{Result: json.RawMessage(`1`)}); err != nil {
		t.Fatalf("the reply after the end of the connection = %v, want it accepted as an observation", err)
	}
	log := written()
	if want := fmt.Sprintf(" info host exposure: exposure reply %d arrived after its request ended", id); !strings.Contains(log, want) {
		t.Fatalf("the log has no %q:\n%s", want, log)
	}
	for _, removed := range []string{" ms after it was sent", "timed out"} {
		if strings.Contains(log, removed) {
			t.Fatalf("the log states a delay or a time limit %q:\n%s", removed, log)
		}
	}
}

// The end of a connection recorded in the turn of the send ends the request the same way.
// contract: exposure.relay.connection-end-ends-its-requests
func TestAConnectionEndInTheTurnOfTheSendEndsTheRelayRequest(t *testing.T) {
	relay := host.NewRelay[string]()
	var requested uint64
	got := relay.Request("main", func(id uint64) error {
		requested = id
		relay.End(id)
		return nil
	})
	if got.Error == nil {
		t.Fatalf("the request whose connection ended answered %+v, want no result", got)
	}
	if err := relay.Resolve(requested, "main", host.ExposureResult{Result: json.RawMessage(`1`)}); err != nil {
		t.Fatalf("the reply after the end of the connection = %v, want it accepted as an observation", err)
	}
}

// contract: exposure.relay.send-failure-1003
func TestRelaySendFailureIsReportedWithoutWaiting(t *testing.T) {
	relay := host.NewRelay[string]()
	got := relay.Request("main", func(uint64) error { return errors.New("webview is gone") })
	if got.Error == nil || got.Error.Code != 1003 {
		t.Fatalf("reply %+v, want 1003", got)
	}
}

// contract: exposure.relay.closed-document-fails-pending-1003
func TestRelayClosedDocumentFailsItsPendingRequests(t *testing.T) {
	relay := host.NewRelay[string]()
	got := relay.Request("main", func(uint64) error {
		relay.Abandon(func(target string) bool { return target == "main" })
		return nil
	})
	if got.Error == nil || got.Error.Code != 1003 {
		t.Fatalf("reply %+v, want 1003", got)
	}
}

// contract: exposure.relay.ended-reply-is-observed
func TestRelayReplyToARequestTheDocumentClosedIsObserved(t *testing.T) {
	relay := host.NewRelay[string]()
	got := relay.Request("main", func(uint64) error {
		relay.Abandon(func(target string) bool { return target == "main" })
		return nil
	})
	if got.Error == nil || got.Error.Code != 1003 {
		t.Fatalf("reply %+v, want 1003", got)
	}
	// The reply to the ended request is accepted, because the document that sent it has ended.
	if err := relay.Resolve(1, "main", host.ExposureResult{Result: json.RawMessage(`1`)}); err != nil {
		t.Fatalf("reply to the ended request = %v, want it accepted as an observation", err)
	}
	// A reply to a request that the relay never sent is still refused.
	if err := relay.Resolve(101, "main", host.ExposureResult{Result: json.RawMessage(`1`)}); err == nil || err.Error() != "exposure reply 101 has no matching request" {
		t.Fatalf("reply to no request = %v", err)
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

// An error member of a document reply names its code and its message. A reply without either is refused, so no code 0 or empty
// message is delivered to the request that waits for it.
// contract: exposure.reply.error-member-names-code-and-message
func TestExposureReplyErrorWithoutACodeOrAMessageIsRefused(t *testing.T) {
	for name, text := range map[string]string{
		"no code":    `{"id": 1, "error": {"message": "failed"}}`,
		"no message": `{"id": 1, "error": {"code": -32000}}`,
	} {
		var reply host.ExposureReplyRequest
		if err := json.Unmarshal([]byte(text), &reply); err == nil || !strings.Contains(err.Error(), "error has no") {
			t.Fatalf("%s: the reply was accepted as %+v (%v)", name, reply, err)
		}
	}
}
