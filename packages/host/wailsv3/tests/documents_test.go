package host_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"unsafe"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// contract: documents.request.accepts-own-surface, documents.request.rejects-foreign-or-missing-caller, documents.request.rejects-invalid-names
func TestDocumentRequestsBelongToTheCallingSurface(t *testing.T) {
	req := host.DocumentRequest{Surface: "tab-1", Document: "page"}
	key, err := host.CheckDocument("tab-1", req)
	if err != nil || key != (host.DocumentKey{Surface: "tab-1", Name: "page"}) {
		t.Fatalf("own surface: %v %v", key, err)
	}
	for _, caller := range []string{"", "tab-2"} {
		if _, err := host.CheckDocument(caller, req); err == nil || !strings.Contains(err.Error(), "not surface") {
			t.Fatalf("caller %q: %v", caller, err)
		}
	}
	for _, name := range []string{"", "Page", "-page", "a/b", strings.Repeat("a", 65)} {
		if _, err := host.CheckDocument("tab-1", host.DocumentRequest{Surface: "tab-1", Document: name}); err == nil {
			t.Fatalf("name %q was accepted", name)
		}
	}
}

// contract: documents.request.ignores-placement-fields, documents.request.url-and-action-default-empty
func TestDocumentRequestDoesNotExposeIndividualPlacement(t *testing.T) {
	var req host.DocumentRequest
	body := `{"surface":"tab-1","document":"page","left":1.5,"top":2,"right":3,"bottom":4,"visible":true}`
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatal(err)
	}
	if req.URL != "" || req.Action != "" {
		t.Fatalf("url %q action %q, want both empty", req.URL, req.Action)
	}
	want := host.DocumentRequest{Surface: "tab-1", Document: "page"}
	if !reflect.DeepEqual(req, want) {
		t.Fatalf("got %+v", req)
	}
}

// contract: documents.registry.rejects-duplicate-reservation, documents.registry.reserved-name-is-not-attached, documents.registry.set-attaches-reserved-name, documents.registry.lists-names-by-handle, documents.registry.surface-close-removes-only-its-documents, documents.registry.rejects-set-after-surface-removed, documents.registry.remove-reserved-returns-empty, documents.registry.remove-attached-returns-handle-once
func TestDocumentsReserveNamesAndCloseWithTheirSurface(t *testing.T) {
	var a, b, c int
	docs := host.NewDocuments()
	one := host.DocumentKey{Surface: "tab-1", Name: "page"}
	two := host.DocumentKey{Surface: "tab-1", Name: "side"}
	other := host.DocumentKey{Surface: "tab-2", Name: "page"}
	for _, key := range []host.DocumentKey{one, two, other} {
		if err := docs.Reserve(key); err != nil {
			t.Fatal(err)
		}
	}
	if err := docs.Reserve(one); err == nil || !strings.Contains(err.Error(), "already attached") {
		t.Fatalf("duplicate name: %v", err)
	}
	if _, err := docs.Get(one); err == nil {
		t.Fatal("a reserved name is not an attached document")
	}
	if !docs.Set(one, unsafe.Pointer(&a)) || !docs.Set(two, unsafe.Pointer(&b)) || !docs.Set(other, unsafe.Pointer(&c)) {
		t.Fatal("reserved names accept their documents")
	}
	if got, err := docs.Get(one); err != nil || got != unsafe.Pointer(&a) {
		t.Fatalf("get: %v %v", got, err)
	}
	names := docs.Names()
	if len(names) != 3 || names[uint64(uintptr(unsafe.Pointer(&c)))] != other || len(docs.All()) != 3 {
		t.Fatalf("names: %v", names)
	}

	removed := docs.RemoveSurface("tab-1")
	if len(removed) != 2 {
		t.Fatalf("surface removal returned %d documents", len(removed))
	}
	if _, err := docs.Get(one); err == nil {
		t.Fatal("a document of a removed surface remains")
	}
	if got, err := docs.Get(other); err != nil || got != unsafe.Pointer(&c) {
		t.Fatal("another surface's document was removed")
	}
	if docs.Set(one, unsafe.Pointer(&a)) {
		t.Fatal("a document created after its surface was removed was accepted")
	}

	if err := docs.Reserve(two); err != nil {
		t.Fatal(err)
	}
	if got, err := docs.Remove(two); err != nil || got != nil {
		t.Fatalf("removing a reserved name: %v %v", got, err)
	}
	if got, err := docs.Remove(other); err != nil || got != unsafe.Pointer(&c) {
		t.Fatalf("detach: %v %v", got, err)
	}
	if _, err := docs.Remove(other); err == nil {
		t.Fatal("a detached name was removed twice")
	}
}

// contract: documents.request.zoom-must-be-finite-positive
func TestDocumentZoomMustBeAFinitePositiveFactor(t *testing.T) {
	for _, body := range []string{`{}`, `{"zoom":0}`, `{"zoom":-1}`} {
		var req host.DocumentRequest
		if err := json.Unmarshal([]byte(body), &req); err != nil {
			t.Fatal(err)
		}
		if _, err := req.ZoomFactor(); err == nil {
			t.Fatalf("%s: zoom was accepted", body)
		}
	}
	var req host.DocumentRequest
	if err := json.Unmarshal([]byte(`{"surface":"tab-1","document":"page","zoom":1.25}`), &req); err != nil {
		t.Fatal(err)
	}
	if zoom, err := req.ZoomFactor(); err != nil || zoom != 1.25 {
		t.Fatalf("zoom %v, %v", zoom, err)
	}
}

// contract: documents.request.entry-requires-offset
func TestDocumentEntryRequiresANonZeroOffset(t *testing.T) {
	for _, body := range []string{`{"action":"entry"}`, `{"action":"entry","offset":0}`, `{"action":"back","offset":1}`, `{"action":"home"}`} {
		var req host.DocumentRequest
		if err := json.Unmarshal([]byte(body), &req); err != nil {
			t.Fatal(err)
		}
		if _, _, err := host.DocumentGoAction(req); err == nil {
			t.Fatalf("%s: the request was accepted", body)
		}
	}
	for body, want := range map[string][2]int{`{"action":"entry","offset":-2}`: {4, -2}, `{"action":"stop"}`: {3, 0}} {
		var req host.DocumentRequest
		if err := json.Unmarshal([]byte(body), &req); err != nil {
			t.Fatal(err)
		}
		action, offset, err := host.DocumentGoAction(req)
		if err != nil || action != want[0] || offset != want[1] {
			t.Fatalf("%s: %d %d %v", body, action, offset, err)
		}
	}
}

// TestDispatcherHandlesACommitBeforeTheMessagesAfterIt verifies that a message received after a commit in the same web view is handled after the handling of that
// commit ends. If the first layout request of a new document were handled before the commit, it would hit the revision of the previous document,
// and the late commit would close the image regions of the new document. The messages of another web view are not waited for.
// contract: documents.commit.precedes-messages
func TestDispatcherHandlesACommitBeforeTheMessagesAfterIt(t *testing.T) {
	release := make(chan struct{})
	events := make(chan string, 4)
	held := make(chan uint64, 4)
	dispatcher := &platform.Dispatcher{
		Committed: func(identifier uint64) {
			<-release
			events <- "commit"
		},
		Receive: func(identifier uint64, body string) { events <- body },
		Held:    func(identifier uint64) { held <- identifier },
	}
	dispatcher.Commit(7)
	dispatcher.Message(7, "place")
	dispatcher.Message(8, "other")

	// The messages of another web view do not wait for the commit. A message of the same web view is held before it is handled.
	seen := map[string]bool{}
	for !seen["other"] || !seen["held"] {
		select {
		case event := <-events:
			if event != "other" {
				t.Fatalf("%q was handled while the commit of its webview was still being handled", event)
			}
			seen["other"] = true
		case identifier := <-held:
			if identifier != 7 {
				t.Fatalf("a message of webview %d was held, want only webview 7", identifier)
			}
			seen["held"] = true
		}
	}
	close(release)
	if first, second := <-events, <-events; first != "commit" || second != "place" {
		t.Fatalf("handled %q then %q, want the commit then its message", first, second)
	}
}

// streamKey is the document region of the tests of the stream subscriptions.
func streamKey(surface, name string) host.DocumentKey {
	return host.DocumentKey{Surface: surface, Name: name}
}

// jsonEqual fails the test when got does not hold the same JSON value as want.
func jsonEqual(t *testing.T, got json.RawMessage, want string) {
	t.Helper()
	var gotValue, wantValue any
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatalf("got %s is not JSON: %v", got, err)
	}
	if err := json.Unmarshal([]byte(want), &wantValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("got %s, want %s", got, want)
	}
}

// contract: document.stream.subscribe-rejects-unknown-stream
func TestDocumentStreamSubscribeRejectsAnUnknownStream(t *testing.T) {
	streams := host.NewDocumentStreams()
	_, _, _, err := streams.Subscribe(streamKey("tab-1", "page"), "pixels")
	if err == nil || err.Error() != `unknown document stream "pixels"` {
		t.Fatalf("subscribe: %v", err)
	}
}

// contract: document.stream.unsubscribe-rejects-unknown-handle
func TestDocumentStreamUnsubscribeRejectsAHandleOfAnotherDocument(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	handle, _, _, err := streams.Subscribe(page, "elements")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := streams.Unsubscribe(streamKey("tab-1", "side"), handle); err == nil ||
		err.Error() != fmt.Sprintf(`document stream handle %d is not subscribed to document "side"`, handle) {
		t.Fatalf("another document: %v", err)
	}
	if _, err := streams.Unsubscribe(page, handle+100); err == nil {
		t.Fatal("an unknown handle was accepted")
	}
}

// requestEntries is the stream message of native with a request entry for each url.
func requestEntries(urls ...string) string {
	entries := make([]string, 0, len(urls))
	for _, url := range urls {
		entries = append(entries, fmt.Sprintf(`{"url":%q}`, url))
	}
	return `{"stream":"requests","message":{"type":"entries","entries":[` + strings.Join(entries, ",") + `]}}`
}

// numbered returns the urls e<first> to e<last - 1>.
func numbered(first, last int) []string {
	var urls []string
	for i := first; i < last; i++ {
		urls = append(urls, fmt.Sprintf("e%d", i))
	}
	return urls
}

// logState fails the test when the request log of the region is not entries entries with dropped dropped.
func logState(t *testing.T, streams *host.DocumentStreams, key host.DocumentKey, entries int, dropped int64) {
	t.Helper()
	if gotEntries, gotDropped, ok := streams.LogState(key); !ok || gotEntries != entries || gotDropped != dropped {
		t.Fatalf("log of %v: %d entries, %d dropped, present %v; want %d entries and %d dropped", key, gotEntries, gotDropped, ok, entries, dropped)
	}
}

// noLog fails the test when the region has a request log.
func noLog(t *testing.T, streams *host.DocumentStreams, key host.DocumentKey) {
	t.Helper()
	if entries, dropped, ok := streams.LogState(key); ok {
		t.Fatalf("%v keeps a request log of %d entries, %d dropped", key, entries, dropped)
	}
}

// replayOf reads the first message of a requests subscription.
func replayOf(t *testing.T, initial json.RawMessage) (string, []json.RawMessage, int64) {
	t.Helper()
	var replay struct {
		Type    string            `json:"type"`
		Entries []json.RawMessage `json:"entries"`
		Dropped int64             `json:"dropped"`
	}
	if err := json.Unmarshal(initial, &replay); err != nil {
		t.Fatalf("first message %s: %v", initial, err)
	}
	return replay.Type, replay.Entries, replay.Dropped
}

// contract: document.stream.first-on-last-off
func TestDocumentStreamTurnsElementCollectionOnAtTheFirstSubscriptionAndOffAtTheLast(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	first, effects, _, err := streams.Subscribe(page, "elements")
	if err != nil {
		t.Fatal(err)
	}
	if want := []host.StreamEffect{{Key: page, Stream: "elements", On: true}}; !reflect.DeepEqual(effects, want) {
		t.Fatalf("first subscription effects %v, want %v", effects, want)
	}
	second, effects, _, err := streams.Subscribe(page, "elements")
	if err != nil || len(effects) != 0 {
		t.Fatalf("second subscription effects %v, %v", effects, err)
	}
	if n := streams.Subscribers(page, "elements"); n != 2 {
		t.Fatalf("subscribers %d, want 2", n)
	}
	if effects, err := streams.Unsubscribe(page, first); err != nil || len(effects) != 0 {
		t.Fatalf("first removal effects %v, %v", effects, err)
	}
	effects, err = streams.Unsubscribe(page, second)
	if err != nil || !reflect.DeepEqual(effects, []host.StreamEffect{{Key: page, Stream: "elements", On: false}}) {
		t.Fatalf("last removal effects %v, %v", effects, err)
	}
	if n := streams.Subscribers(page, "elements"); n != 0 {
		t.Fatalf("subscribers after the last removal %d", n)
	}
}

// contract: document.stream.native-refusal-rejects-subscription
func TestDocumentStreamAbandonedSubscriptionIsNotKept(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	handle, _, _, err := streams.Subscribe(page, "elements")
	if err != nil {
		t.Fatal(err)
	}
	streams.Abandon(handle)
	if n := streams.Subscribers(page, "elements"); n != 0 {
		t.Fatalf("subscribers after the refusal %d", n)
	}
	if _, err := streams.Unsubscribe(page, handle); err == nil {
		t.Fatal("an abandoned handle was ended")
	}
}

// contract: document.stream.attach-starts-request-collection
func TestDocumentStreamAttachCreatesTheRequestLogAndTurnsItsCollectionOn(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	if _, _, _, err := streams.Subscribe(page, "requests"); err == nil || err.Error() != `document "page" has no request log` {
		t.Fatalf("subscription of a region without a log: %v", err)
	}
	effects, err := streams.Attach(page)
	if err != nil || !reflect.DeepEqual(effects, []host.StreamEffect{{Key: page, Stream: "requests", On: true}}) {
		t.Fatalf("attach effects %v, %v", effects, err)
	}
	logState(t, streams, page, 0, 0)
	if _, err := streams.Attach(page); err == nil || err.Error() != `document "page" already has a request log` {
		t.Fatalf("second attach: %v", err)
	}
}

// contract: document.stream.request-log-lives-with-the-region
func TestDocumentRequestLogOutlivesTheSubscriptionsOfTheRegion(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	if _, err := streams.Attach(page); err != nil {
		t.Fatal(err)
	}
	handle, _, _, err := streams.Subscribe(page, "requests")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := streams.Deliver(page, requestEntries(numbered(0, 250)...)); err != nil {
		t.Fatal(err)
	}
	if _, err := streams.Unsubscribe(page, handle); err != nil {
		t.Fatal(err)
	}
	logState(t, streams, page, 200, 50)
	_, _, initial, err := streams.Subscribe(page, "requests")
	if err != nil {
		t.Fatal(err)
	}
	if _, entries, dropped := replayOf(t, initial); dropped != 50 || len(entries) != 200 ||
		string(entries[0]) != `{"url":"e50"}` || string(entries[199]) != `{"url":"e249"}` {
		t.Fatalf("first message after the end of every subscription: %s", initial)
	}
}

// contract: document.stream.request-log-lives-with-the-region
func TestDocumentRequestLogKeepsTheEntriesThatArriveWithoutASubscription(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	if _, err := streams.Attach(page); err != nil {
		t.Fatal(err)
	}
	result, err := streams.Deliver(page, requestEntries("navigation", "a"))
	if err != nil || len(result.Deliveries) != 0 {
		t.Fatalf("deliveries %v, %v", result.Deliveries, err)
	}
	logState(t, streams, page, 2, 0)
	_, _, initial, err := streams.Subscribe(page, "requests")
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, initial, `{"type":"entries","entries":[{"url":"navigation"},{"url":"a"}],"dropped":0}`)
}

// contract: document.stream.request-subscription-changes-no-collection
func TestDocumentRequestsSubscriptionOfARegionWithElementsSubscriptionPostsNoEntryAgain(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	if _, err := streams.Attach(page); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := streams.Subscribe(page, "elements"); err != nil {
		t.Fatal(err)
	}
	handle, effects, _, err := streams.Subscribe(page, "requests")
	if err != nil || len(effects) != 0 {
		t.Fatalf("a requests subscription changed a collection: %v, %v", effects, err)
	}
	if _, err := streams.Deliver(page, requestEntries(numbered(0, 210)...)); err != nil {
		t.Fatal(err)
	}
	if effects, err := streams.Unsubscribe(page, handle); err != nil || len(effects) != 0 {
		t.Fatalf("the end of the requests subscription turned the collection off: %v, %v", effects, err)
	}
	_, effects, initial, err := streams.Subscribe(page, "requests")
	if err != nil || len(effects) != 0 {
		t.Fatalf("a new requests subscription turned the collection on, so the document posts its entries again: %v, %v", effects, err)
	}
	logState(t, streams, page, 200, 10)
	if _, entries, dropped := replayOf(t, initial); dropped != 10 || len(entries) != 200 || string(entries[0]) != `{"url":"e10"}` {
		t.Fatalf("first message of the new subscription: %s", initial)
	}
}

// contract: document.stream.page-load-removes-subscriptions, document.stream.region-close-removes-subscriptions
func TestDocumentStreamRemovalEndsSubscriptionsAndReleasesTheLog(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	side := streamKey("tab-1", "side")
	other := streamKey("tab-2", "page")
	for _, key := range []host.DocumentKey{page, side, other} {
		if _, err := streams.Attach(key); err != nil {
			t.Fatal(err)
		}
		for _, stream := range []string{"elements", "requests"} {
			if _, _, _, err := streams.Subscribe(key, stream); err != nil {
				t.Fatal(err)
			}
		}
	}
	streams.RemoveSurface("tab-1")
	for _, key := range []host.DocumentKey{page, side} {
		for _, stream := range []string{"elements", "requests"} {
			if n := streams.Subscribers(key, stream); n != 0 {
				t.Fatalf("%v %s: %d subscribers after the page loaded a new document", key, stream, n)
			}
		}
		noLog(t, streams, key)
	}
	if n := streams.Subscribers(other, "requests"); n != 1 {
		t.Fatalf("another surface lost its subscription: %d", n)
	}
	logState(t, streams, other, 0, 0)
	streams.RemoveRegion(other)
	if n := streams.Subscribers(other, "requests"); n != 0 {
		t.Fatalf("subscribers after the region closed: %d", n)
	}
	noLog(t, streams, other)
	// An entry that arrives after the removal of the region has no log to enter.
	result, err := streams.Deliver(other, requestEntries("a"))
	if err != nil || len(result.Deliveries) != 0 {
		t.Fatalf("deliveries after the removal %v, %v", result.Deliveries, err)
	}
	noLog(t, streams, other)
	if _, _, _, err := streams.Subscribe(other, "requests"); err == nil || err.Error() != `document "page" has no request log` {
		t.Fatalf("subscription of a removed region: %v", err)
	}
}

// contract: document.stream.request-log-replays-with-dropped
func TestDocumentRequestLogReplaysItsLastEntriesWithTheDroppedCount(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	if _, err := streams.Attach(page); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := streams.Subscribe(page, "requests"); err != nil {
		t.Fatal(err)
	}
	result, err := streams.Deliver(page, requestEntries(numbered(0, 250)...))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 1 || result.Ack {
		t.Fatalf("deliveries %v ack %v", result.Deliveries, result.Ack)
	}
	logState(t, streams, page, 200, 50)
	_, _, initial, err := streams.Subscribe(page, "requests")
	if err != nil {
		t.Fatal(err)
	}
	if kind, entries, dropped := replayOf(t, initial); kind != "entries" || dropped != 50 || len(entries) != 200 ||
		string(entries[0]) != `{"url":"e50"}` || string(entries[199]) != `{"url":"e249"}` {
		t.Fatalf("replay %s", initial)
	}
	result, err = streams.Deliver(page, requestEntries("e250"))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 2 {
		t.Fatalf("deliveries to both subscriptions: %d", len(result.Deliveries))
	}
	jsonEqual(t, result.Deliveries[1].Message, `{"type":"entries","entries":[{"url":"e250"}],"dropped":51}`)
}

// contract: document.stream.reset-clears-request-log
func TestDocumentStreamResetClearsTheRequestLog(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	if _, err := streams.Attach(page); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := streams.Subscribe(page, "requests"); err != nil {
		t.Fatal(err)
	}
	if _, err := streams.Deliver(page, requestEntries(numbered(0, 250)...)); err != nil {
		t.Fatal(err)
	}
	logState(t, streams, page, 200, 50)
	result, err := streams.Deliver(page, `{"stream":"requests","message":{"type":"reset"}}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 1 {
		t.Fatalf("reset deliveries %d", len(result.Deliveries))
	}
	jsonEqual(t, result.Deliveries[0].Message, `{"type":"reset"}`)
	logState(t, streams, page, 0, 0)
	_, _, initial, err := streams.Subscribe(page, "requests")
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, initial, `{"type":"entries","entries":[],"dropped":0}`)
}

// contract: document.stream.delivers-to-subscribing-surface-only
func TestDocumentStreamMessagesReachOnlyTheSubscriptionsOfTheirStream(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	other := streamKey("tab-2", "page")
	for _, key := range []host.DocumentKey{page, other} {
		if _, err := streams.Attach(key); err != nil {
			t.Fatal(err)
		}
	}
	requests, _, _, _ := streams.Subscribe(page, "requests")
	elements, _, _, _ := streams.Subscribe(page, "elements")
	foreign, _, _, _ := streams.Subscribe(other, "requests")
	result, err := streams.Deliver(page, `{"stream":"requests","message":{"type":"entries","entries":[{"url":"a"}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 1 || result.Deliveries[0].Surface != "tab-1" || result.Deliveries[0].Handle != requests {
		t.Fatalf("deliveries %+v, want only handle %d of tab-1", result.Deliveries, requests)
	}
	if result.Deliveries[0].Handle == elements || result.Deliveries[0].Handle == foreign {
		t.Fatal("a message reached another stream or another document")
	}
}

// contract: document.stream.snapshot-acknowledged-after-delivery
func TestDocumentStreamSnapshotIsAcknowledgedAfterItsDelivery(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	handle, _, _, err := streams.Subscribe(page, "elements")
	if err != nil {
		t.Fatal(err)
	}
	snapshot := `{"stream":"elements","message":{"type":"snapshot","seq":3,"nodes":[{"depth":0,"tag":"html","id":"","class":""}],"total":1,"truncated":false}}`
	result, err := streams.Deliver(page, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Ack || result.Seq != 3 || len(result.Deliveries) != 1 || result.Deliveries[0].Handle != handle {
		t.Fatalf("snapshot result %+v", result)
	}
	jsonEqual(t, result.Deliveries[0].Message, `{"type":"snapshot","seq":3,"nodes":[{"depth":0,"tag":"html","id":"","class":""}],"total":1,"truncated":false}`)
	if _, err := streams.Unsubscribe(page, handle); err != nil {
		t.Fatal(err)
	}
	result, err = streams.Deliver(page, `{"stream":"elements","message":{"type":"snapshot","seq":4,"nodes":[],"total":0,"truncated":false}}`)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Ack || result.Seq != 4 || len(result.Deliveries) != 0 {
		t.Fatalf("snapshot without subscriptions %+v", result)
	}
}

// contract: document.stream.rejects-unknown-message
func TestDocumentStreamRejectsInvalidMessages(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	if _, _, _, err := streams.Subscribe(page, "elements"); err != nil {
		t.Fatal(err)
	}
	for body, want := range map[string]string{
		`not json`: "document stream message is not JSON",
		`{"stream":"pixels","message":{"type":"reset"}}`:      `unknown document stream "pixels"`,
		`{"stream":"requests","message":{"type":"pixels"}}`:   `document stream "requests" sent an unknown message type "pixels"`,
		`{"stream":"elements","message":{"type":"snapshot"}}`: `document stream "elements" snapshot has no seq`,
	} {
		if _, err := streams.Deliver(page, body); err == nil || err.Error() != want {
			t.Fatalf("%s: %v, want %s", body, err, want)
		}
	}
}

// contract: document.stream.process-end-removes-subscriptions
func TestDocumentStreamEndedPageProcessKeepsTheRegionsOfItsSurface(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	side := streamKey("tab-1", "side")
	other := streamKey("tab-2", "page")
	for _, key := range []host.DocumentKey{page, side, other} {
		if _, err := streams.Attach(key); err != nil {
			t.Fatal(err)
		}
	}
	for _, sub := range []struct {
		key    host.DocumentKey
		stream string
	}{{page, "requests"}, {side, "elements"}, {other, "requests"}} {
		if _, _, _, err := streams.Subscribe(sub.key, sub.stream); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := streams.Deliver(page, requestEntries("a")); err != nil {
		t.Fatal(err)
	}
	// The regions stay until the page loads again, so they keep their request collection and their request log.
	effects := streams.RemovePage("tab-1")
	if want := []host.StreamEffect{{Key: side, Stream: "elements", On: false}}; !reflect.DeepEqual(effects, want) {
		t.Fatalf("effects of the process end %v, want %v", effects, want)
	}
	if n := streams.Subscribers(page, "requests") + streams.Subscribers(side, "elements"); n != 0 {
		t.Fatalf("subscribers after the process ended: %d", n)
	}
	if n := streams.Subscribers(other, "requests"); n != 1 {
		t.Fatalf("another surface lost its subscription: %d", n)
	}
	logState(t, streams, page, 1, 0)
	logState(t, streams, side, 0, 0)
}

// contract: document.stream.window-close-removes-subscriptions
func TestDocumentStreamClosedWindowReleasesTheRequestLog(t *testing.T) {
	streams := host.NewDocumentStreams()
	page := streamKey("tab-1", "page")
	if _, err := streams.Attach(page); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := streams.Subscribe(page, "requests"); err != nil {
		t.Fatal(err)
	}
	if _, err := streams.Deliver(page, requestEntries("a")); err != nil {
		t.Fatal(err)
	}
	// The close of a window removes each of its surfaces with their regions.
	streams.RemoveSurface("tab-1")
	if n := streams.Subscribers(page, "requests"); n != 0 {
		t.Fatalf("subscribers after the window closed: %d", n)
	}
	noLog(t, streams, page)
}

// contract: document.stream.ack-refusal-names-seq
func TestDocumentStreamAckRefusalNamesTheDocumentStreamAndSeq(t *testing.T) {
	err := host.StreamAckRefusal(streamKey("tab-1", "page"), "elements", 7)
	if err == nil || err.Error() != `document "page" stream elements: seq 7 was not sent` {
		t.Fatalf("refusal: %v", err)
	}
}

// contract: documents.query.reply-is-the-region-report
func TestDocumentQueryReplyIsTheRegionReport(t *testing.T) {
	report, err := host.ParseDocumentReport("page", `{"media":true,"capture":true,"form":false}`)
	if err != nil || report != (host.DocumentReport{Media: true, Capture: true, Form: false}) {
		t.Fatalf("report %+v, %v", report, err)
	}
	if _, err := host.ParseDocumentReport("page", `{"error":"the document region is closed"}`); err == nil || err.Error() != "document page: the document region is closed" {
		t.Fatalf("error reply: %v", err)
	}
	for _, reply := range []string{`{"media":"playing","capture":false,"form":false}`, `{"media":false,"capture":false}`, `not json`} {
		_, err := host.ParseDocumentReport("page", reply)
		if want := "document page answered an invalid query reply: " + reply; err == nil || err.Error() != want {
			t.Fatalf("%s: %v", reply, err)
		}
	}
}

// contract: documents.request.interaction-state-must-not-be-empty
func TestDocumentInteractionStateMustNotBeEmpty(t *testing.T) {
	for body, want := range map[string]string{`{}`: "", `{"interactionState":"AAAA"}`: "AAAA"} {
		var req host.DocumentRequest
		if err := json.Unmarshal([]byte(body), &req); err != nil {
			t.Fatal(err)
		}
		if state, err := req.RestoreState(); err != nil || state != want {
			t.Fatalf("%s: %q, %v", body, state, err)
		}
	}
	var req host.DocumentRequest
	if err := json.Unmarshal([]byte(`{"interactionState":""}`), &req); err != nil {
		t.Fatal(err)
	}
	if _, err := req.RestoreState(); err == nil || err.Error() != "document interactionState must not be empty" {
		t.Fatalf("empty state: %v", err)
	}
}
