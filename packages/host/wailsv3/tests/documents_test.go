package host_test

import (
	"encoding/json"
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

// TestDispatcherHandlesACommitBeforeTheMessagesAfterIt 는 같은 웹뷰에서 commit 뒤에 받은 메시지가 그 commit 의
// 처리가 끝난 뒤에 처리되는지 검증한다. 새 문서의 첫 배치 요청이 commit 보다 먼저 처리되면 이전 문서의 리비전에
// 걸리고, 늦은 commit 이 새 문서의 그림 영역을 닫는다. 다른 웹뷰의 메시지는 기다리지 않는다.
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

	// 다른 웹뷰의 메시지는 commit 을 기다리지 않는다. 같은 웹뷰의 메시지는 처리되기 전에 보류된다.
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
