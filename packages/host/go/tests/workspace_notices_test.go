package host_test

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// contract: workspace.notices.put-replaces-list
func TestNoticesPutReplacesTheList(t *testing.T) {
	config := t.TempDir()
	store := host.NewWorkspace(config)
	missing, err := store.Apply(host.WorkspaceRequest{Kind: "notices"})
	if err != nil || missing != nil {
		t.Fatalf("a missing notices.json read %v, %v, want nil", missing, err)
	}
	first := []any{map[string]any{"id": "n1", "kind": "info", "title": "Built"}, map[string]any{"id": "n2", "kind": "error", "title": "Failed"}}
	written, err := store.Apply(host.WorkspaceRequest{Kind: "noticesPut", Notices: first})
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(config, "notices.json"))
	if err != nil {
		t.Fatal(err)
	}
	if size, ok := written.(int); !ok || int64(size) != info.Size() {
		t.Fatalf("a put returned %v, want the size %d of the written file", written, info.Size())
	}
	// Another store of the same configuration directory reads the list that the put wrote.
	document, err := host.NewWorkspace(config).Apply(host.WorkspaceRequest{Kind: "notices"})
	if err != nil {
		t.Fatal(err)
	}
	want := host.Record{"format": float64(2), "notices": first}
	if !reflect.DeepEqual(document, want) {
		t.Fatalf("notices read %v, want %v", document, want)
	}
	// A put replaces the whole list, so an empty list leaves no entry.
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "noticesPut", Notices: []any{}}); err != nil {
		t.Fatal(err)
	}
	document, err = store.Apply(host.WorkspaceRequest{Kind: "notices"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(document, host.Record{"format": float64(2), "notices": []any{}}) {
		t.Fatalf("a replacing put left %v", document)
	}
}

// contract: workspace.notices.rejects-other-format
func TestNoticesRejectOtherFormatAndNonListValues(t *testing.T) {
	config := t.TempDir()
	store := host.NewWorkspace(config)
	path := filepath.Join(config, "notices.json")
	if err := os.WriteFile(path, []byte(`{"format":1,"notices":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := store.Apply(host.WorkspaceRequest{Kind: "noticesPut", Notices: []any{}})
	if want := path + ": notices.json: format must be 2"; err == nil || err.Error() != want {
		t.Fatalf("a put into format 1 returned %v, want %q", err, want)
	}
	if data, _ := os.ReadFile(path); string(data) != `{"format":1,"notices":[]}` {
		t.Fatalf("a refused put changed the file: %s", data)
	}
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "notices"}); err == nil || err.Error() != path+": notices.json: format must be 2" {
		t.Fatalf("a read of format 1 returned %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	const want = "notices put requires a list of notices"
	for _, value := range []any{nil, map[string]any{}, "n1"} {
		if _, err := store.Apply(host.WorkspaceRequest{Kind: "noticesPut", Notices: value}); err == nil || err.Error() != want {
			t.Fatalf("a put of %v returned %v, want %q", value, err, want)
		}
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("a refused put created notices.json: %v", err)
	}
}
