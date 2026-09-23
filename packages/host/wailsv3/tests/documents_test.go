package host_test

import (
	"encoding/json"
	"strings"
	"testing"
	"unsafe"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
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
	if req != want {
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
