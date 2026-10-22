package host_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// contract: workspace.settings.records-each-change
func TestEachSettingsChangeIsRecordedWithItsKeys(t *testing.T) {
	root := t.TempDir()
	config := t.TempDir()
	log := support.StartWriter(t, config)
	store := host.NewWorkspace(config)
	for _, req := range []host.WorkspaceRequest{
		{Kind: "add", Project: host.Record{"id": "prj-test", "root": root, "identity": "1:2"}},
		{Kind: "settings", Patch: host.Record{"mode": "light", "gap": 6}},
		{Kind: "settings", Remove: []string{"gap", "missing"}},
		{Kind: "settings", ID: "prj-test", Patch: host.Record{"gap": 12}},
	} {
		if _, err := store.Apply(req); err != nil {
			t.Fatal(err)
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var seen []string
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] != "host.workspace.settings" {
			continue
		}
		fields := event["fields"].(map[string]any)
		seen = append(seen, fields["scope"].(string)+" set="+fields["set"].(string)+" removed="+fields["removed"].(string))
	}
	want := []string{"common set=gap,mode removed=", "common set= removed=gap", "prj-test set=gap removed="}
	if !slices.Equal(seen, want) {
		t.Fatalf("host.workspace.settings events = %q, want %q", seen, want)
	}
}

// contract: workspace.config-dir.creates-requested-path, workspace.config-dir.rejects-empty-path, workspace.config-dir.rejects-path-under-file
func TestNewConfigDirectoryPreservesRequestedPath(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "new", "configuration")
	got, err := host.PrepareConfigDirectory(path)
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(path)
	if err != nil || got != want {
		t.Fatalf("canonical directory = %q, want %q: %v", got, want, err)
	}
	info, err := os.Stat(got)
	if err != nil || !info.IsDir() {
		t.Fatalf("configuration directory was not created: %v", err)
	}
	if _, err := host.PrepareConfigDirectory(""); err == nil {
		t.Fatal("empty configuration path was accepted")
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := host.PrepareConfigDirectory(filepath.Join(file, "config")); err == nil {
		t.Fatal("a file was treated as a configuration directory")
	}
}

// contract: workspace.config-dir.creates-owner-only
func TestCreatedConfigDirectoryIsOwnerOnlyAndAnExistingOneKeepsItsMode(t *testing.T) {
	root := t.TempDir()
	created, err := host.PrepareConfigDirectory(filepath.Join(root, "created"))
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(created); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("created configuration directory mode: %v %v", info.Mode().Perm(), err)
	}
	existing := filepath.Join(root, "existing")
	if err := os.Mkdir(existing, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(existing, 0o755); err != nil {
		t.Fatal(err)
	}
	kept, err := host.PrepareConfigDirectory(existing)
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(kept); err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("existing configuration directory mode changed: %v %v", info.Mode().Perm(), err)
	}
}

// contract: workspace.settings.project-file-holds-only-overrides, workspace.settings.persist-across-reopen, workspace.settings.reset-removes-override, workspace.settings.rejects-project-opening-override, workspace.settings.invalid-common-file-not-overwritten
func TestSettingsFilesAndInheritance(t *testing.T) {
	root := t.TempDir()
	config := t.TempDir()
	store := host.NewWorkspace(config)
	apply := func(req host.WorkspaceRequest) any {
		t.Helper()
		result, err := store.Apply(req)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	apply(host.WorkspaceRequest{Kind: "add", Project: host.Record{"id": "prj-test", "root": root, "identity": "1:2"}})
	apply(host.WorkspaceRequest{Kind: "settings", Patch: host.Record{"mode": "light", "gap": 6, "projectOpening": "windows"}})
	apply(host.WorkspaceRequest{Kind: "settings", ID: "prj-test", Patch: host.Record{"gap": 12}})
	var project host.Record
	if err := readJSON(t, filepath.Join(root, ".soksak", "settings.json"), &project); err != nil {
		t.Fatal(err)
	}
	// The file holds its overrides and the format member of the current form (docs/spec/installation.md#stored-data-migration).
	if len(project) != 2 || project["gap"] != float64(12) || project["format"] != float64(1) {
		t.Fatalf("project file includes inherited settings: %v", project)
	}
	reopened := host.NewWorkspace(config)
	snapshot, err := reopened.Apply(host.WorkspaceRequest{Kind: "snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	got := snapshot.(host.Record)
	if got["common"].(host.Record)["mode"] != "light" || got["projects"].([]host.Record)[0]["settings"].(host.Record)["gap"] != float64(12) {
		t.Fatalf("settings did not survive reopening: %v", got)
	}
	apply(host.WorkspaceRequest{Kind: "settings", ID: "prj-test", Remove: []string{"gap"}})
	project = nil
	if err := readJSON(t, filepath.Join(root, ".soksak", "settings.json"), &project); err != nil {
		t.Fatal(err)
	}
	// The snapshot migrated the file, so the format carrier remains after the override is removed.
	if len(project) != 1 || project["format"] != float64(1) {
		t.Fatalf("reset did not remove the override: %v", project)
	}
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "settings", ID: "prj-test", Patch: host.Record{"projectOpening": "tabs"}}); err == nil {
		t.Fatal("project opening policy accepted a folder override")
	}
	if err := os.WriteFile(filepath.Join(config, "settings.json"), []byte("null"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "settings", Patch: host.Record{"gap": 2}}); err == nil {
		t.Fatal("invalid settings were overwritten")
	}
	data, _ := os.ReadFile(filepath.Join(config, "settings.json"))
	if string(data) != "null" {
		t.Fatal("invalid file was changed")
	}
}

// contract: workspace.settings.concurrent-patches-preserved, workspace.projects.move-reorders, workspace.projects.remove-keeps-remaining-order
func TestConcurrentSettingsAndProjectOrder(t *testing.T) {
	store := host.NewWorkspace(t.TempDir())
	for _, id := range []string{"first", "second", "third"} {
		if _, err := store.Apply(host.WorkspaceRequest{Kind: "add", Project: host.Record{"id": id, "identity": id, "root": t.TempDir()}}); err != nil {
			t.Fatal(err)
		}
	}
	var calls sync.WaitGroup
	for _, key := range []string{"mode", "theme", "rail"} {
		calls.Add(1)
		go func(key string) {
			defer calls.Done()
			if _, err := store.Apply(host.WorkspaceRequest{Kind: "settings", Patch: host.Record{key: key}}); err != nil {
				t.Error(err)
			}
		}(key)
	}
	calls.Wait()
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "move", ID: "third", Delta: ptr(-2)}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.Apply(host.WorkspaceRequest{Kind: "snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	got := snapshot.(host.Record)
	if len(got["common"].(host.Record)) != 3 {
		t.Fatal("concurrent updates lost settings")
	}
	projects := got["projects"].([]host.Record)
	if projects[0]["id"] != "third" {
		t.Fatal("saved project order is incorrect")
	}
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "remove", ID: "third"}); err != nil {
		t.Fatal(err)
	}
	snapshot, _ = store.Apply(host.WorkspaceRequest{Kind: "snapshot"})
	if snapshot.(host.Record)["projects"].([]host.Record)[0]["id"] != "first" {
		t.Fatal("first remaining project is incorrect")
	}
}

// contract: workspace.folder.aliases-share-identity, workspace.folder.rejects-file
func TestFolderIdentity(t *testing.T) {
	root := t.TempDir()
	link := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	first, err := host.ResolveProjectFolder(root)
	if err != nil {
		t.Fatal(err)
	}
	alias, err := host.ResolveProjectFolder(filepath.Join(link, "."))
	if err != nil {
		t.Fatal(err)
	}
	if first != alias {
		t.Fatalf("directory alias differs: %v %v", first, alias)
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := host.ResolveProjectFolder(file); err == nil {
		t.Fatal("a file was accepted as a project directory")
	}
}

// readJSON reads the JSON object of path into into.
func readJSON(t *testing.T, path string, into *host.Record) error {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, into)
}

// contract: workspace.projects.plugin-data-patched
func TestAProjectPatchStoresPluginDataAndRejectsUnknownFields(t *testing.T) {
	config := t.TempDir()
	root := t.TempDir()
	store := host.NewWorkspace(config)
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "add", Project: host.Record{"id": "prj-test", "root": root, "identity": "1:2"}}); err != nil {
		t.Fatal(err)
	}
	plugins := map[string]any{"probe": map[string]any{"marks": []any{"a.txt"}}}
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "patch", ID: "prj-test", Patch: host.Record{"plugins": plugins}}); err != nil {
		t.Fatalf("plugins patch: %v", err)
	}
	snapshot, err := host.NewWorkspace(config).Apply(host.WorkspaceRequest{Kind: "snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(snapshot)
	var read struct {
		Projects []map[string]any `json:"projects"`
	}
	if err := json.Unmarshal(encoded, &read); err != nil || len(read.Projects) != 1 {
		t.Fatalf("snapshot %s: %v", encoded, err)
	}
	if got, _ := json.Marshal(read.Projects[0]["plugins"]); string(got) != `{"probe":{"marks":["a.txt"]}}` {
		t.Fatalf("stored plugins = %s", got)
	}
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "patch", ID: "prj-test", Patch: host.Record{"other": 1}}); err == nil {
		t.Fatal("an unknown project field was accepted")
	}
}

// contract: workspace.folder.messages
func TestFolderMessages(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "gone", "child")
	if _, err := host.ResolveProjectFolder(missing); err == nil || err.Error() != "project directory does not exist: "+missing {
		t.Fatalf("missing directory error: %v", err)
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.ResolveProjectFolder(file); err == nil || err.Error() != "not a project directory: "+resolved {
		t.Fatalf("file error: %v", err)
	}
	closed := filepath.Join(root, "closed")
	if err := os.Mkdir(closed, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(closed, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(closed, 0700); err != nil {
			t.Error(err)
		}
	})
	inside := filepath.Join(closed, "child")
	if _, err := host.ResolveProjectFolder(inside); err == nil || err.Error() != "project directory is not readable: "+inside {
		t.Fatalf("unreadable directory error: %v", err)
	}
}

// contract: workspace.projects.move-requires-delta
func TestMoveWithoutDeltaIsRefused(t *testing.T) {
	store := host.NewWorkspace(t.TempDir())
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "add", Project: host.Record{"id": "first", "identity": "first", "root": t.TempDir()}}); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`{"kind":"move","id":"first"}`, `{"kind":"move","id":"first","delta":null}`} {
		var request host.WorkspaceRequest
		if err := json.Unmarshal([]byte(raw), &request); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Apply(request); err == nil || err.Error() != "move delta is missing" {
			t.Errorf("%s = %v", raw, err)
		}
	}
}

func ptr(n int) *int { return &n }

// contract: workspace.settings.rejects-project-text-size-override
func TestProjectTextSizeOverrideIsRejected(t *testing.T) {
	root := t.TempDir()
	store := host.NewWorkspace(t.TempDir())
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "add", Project: host.Record{"id": "prj-test", "root": root, "identity": "1:2"}}); err != nil {
		t.Fatal(err)
	}
	_, err := store.Apply(host.WorkspaceRequest{Kind: "settings", ID: "prj-test", Patch: host.Record{"textSize": 1.5}})
	if want := "textSize is common-only"; err == nil || err.Error() != want {
		t.Fatalf("a project textSize write returned %v, want %q", err, want)
	}
	path := filepath.Join(root, ".soksak", "settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"textSize":1.5}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = store.Apply(host.WorkspaceRequest{Kind: "snapshot"})
	if want := path + ": textSize is common-only"; err == nil || err.Error() != want {
		t.Fatalf("a project settings file with textSize returned %v, want %q", err, want)
	}
}

// contract: workspace.tab-state.put-keeps-other-entries
func TestTabStatePutKeepsOtherEntries(t *testing.T) {
	config := t.TempDir()
	first := host.NewWorkspace(config)
	second := host.NewWorkspace(config)
	missing, err := first.Apply(host.WorkspaceRequest{Kind: "tabState"})
	if err != nil || missing != nil {
		t.Fatalf("a missing tab-state.json read %v, %v, want nil", missing, err)
	}
	written, err := first.Apply(host.WorkspaceRequest{Kind: "tabStatePut", Tab: "tab-a", Entry: host.Record{"kept": true}})
	if err != nil {
		t.Fatal(err)
	}
	if written.(int) <= 0 {
		t.Fatalf("a tab state put returned %v bytes", written)
	}
	if _, err := second.Apply(host.WorkspaceRequest{Kind: "tabStatePut", Tab: "tab-b", Entry: host.Record{"label": "b", "state": map[string]any{"format": 1, "value": map[string]any{"x": 1}}}}); err != nil {
		t.Fatal(err)
	}
	document, err := first.Apply(host.WorkspaceRequest{Kind: "tabState"})
	if err != nil {
		t.Fatal(err)
	}
	tabs := document.(host.Record)["tabs"].(map[string]any)
	if document.(host.Record)["format"] != float64(1) || len(tabs) != 2 || tabs["tab-a"].(map[string]any)["kept"] != true || tabs["tab-b"].(map[string]any)["label"] != "b" {
		t.Fatalf("two puts of different tabs stored %v", document)
	}
	last, err := second.Apply(host.WorkspaceRequest{Kind: "tabStatePut", Tab: "tab-a"})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(config, "tab-state.json")
	if info, err := os.Stat(path); err != nil || int64(last.(int)) != info.Size() {
		t.Fatalf("a removal returned %v bytes for the file %v (%v)", last, info, err)
	}
	document, _ = first.Apply(host.WorkspaceRequest{Kind: "tabState"})
	if tabs := document.(host.Record)["tabs"].(map[string]any); len(tabs) != 1 || tabs["tab-b"] == nil {
		t.Fatalf("a null entry left %v", document)
	}
}

// contract: workspace.tab-session.put-rewrites-own-file
func TestTabSessionPutRewritesOnlyItsOwnFile(t *testing.T) {
	config := t.TempDir()
	store := host.NewWorkspace(config)
	apply := func(req host.WorkspaceRequest) any {
		t.Helper()
		result, err := store.Apply(req)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	if missing := apply(host.WorkspaceRequest{Kind: "tabSession", Tab: "tab-a"}); missing != nil {
		t.Fatalf("a missing session file read %v, want nil", missing)
	}
	if tabs := apply(host.WorkspaceRequest{Kind: "tabSessions"}).([]string); len(tabs) != 0 {
		t.Fatalf("an absent directory listed %v", tabs)
	}
	apply(host.WorkspaceRequest{Kind: "tabStatePut", Tab: "tab-a", Entry: host.Record{"kept": true}})
	state, _ := os.ReadFile(filepath.Join(config, "tab-state.json"))
	written := apply(host.WorkspaceRequest{Kind: "tabSessionPut", Tab: "tab-a", Regions: host.Record{"page": map[string]any{"session": "AAAA"}}})
	apply(host.WorkspaceRequest{Kind: "tabSessionPut", Tab: "tab-b", Regions: host.Record{"page": map[string]any{"session": "BBBB"}}})
	path := filepath.Join(config, "tab-sessions", "tab-a.json")
	otherPath := filepath.Join(config, "tab-sessions", "tab-b.json")
	other, _ := os.ReadFile(otherPath)
	if info, err := os.Stat(path); err != nil || int64(written.(int)) != info.Size() {
		t.Fatalf("a session put returned %v bytes for the file %v (%v)", written, info, err)
	}
	apply(host.WorkspaceRequest{Kind: "tabSessionPut", Tab: "tab-a", Regions: host.Record{"page": map[string]any{"session": "CCCC"}, "side": map[string]any{"session": "DDDD"}}})
	document := apply(host.WorkspaceRequest{Kind: "tabSession", Tab: "tab-a"}).(host.Record)
	regions := document["regions"].(map[string]any)
	if document["format"] != float64(1) || len(regions) != 2 || regions["page"].(map[string]any)["session"] != "CCCC" || regions["side"].(map[string]any)["session"] != "DDDD" {
		t.Fatalf("a second put stored %v", document)
	}
	if now, _ := os.ReadFile(otherPath); string(now) != string(other) {
		t.Fatalf("a put of tab-a changed the file of tab-b: %s", now)
	}
	if now, _ := os.ReadFile(filepath.Join(config, "tab-state.json")); string(now) != string(state) {
		t.Fatalf("a session put changed tab-state.json: %s", now)
	}
	if tabs := apply(host.WorkspaceRequest{Kind: "tabSessions"}).([]string); len(tabs) != 2 || tabs[0] != "tab-a" || tabs[1] != "tab-b" {
		t.Fatalf("the listing is %v", tabs)
	}
	for range 2 {
		if removed := apply(host.WorkspaceRequest{Kind: "tabSessionPut", Tab: "tab-a"}); removed != nil {
			t.Fatalf("a null put returned %v", removed)
		}
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("a null put left the file (%v)", err)
	}
	if tabs := apply(host.WorkspaceRequest{Kind: "tabSessions"}).([]string); len(tabs) != 1 || tabs[0] != "tab-b" {
		t.Fatalf("the listing after a removal is %v", tabs)
	}
}

// contract: workspace.tab-session.rejects-other-format, workspace.tab-session.rejects-invalid-request
func TestTabSessionRejectsOtherFormatAndInvalidRequests(t *testing.T) {
	config := t.TempDir()
	store := host.NewWorkspace(config)
	folder := filepath.Join(config, "tab-sessions")
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(folder, "tab-a.json")
	for _, c := range []struct{ text, found string }{
		{`{"format":2,"regions":{}}`, "tab session format 2 is not 1"},
		{`{"regions":{}}`, "tab session format missing is not 1"},
		{`{"format":1,"regions":[]}`, "tab session regions is not an object"},
	} {
		if err := os.WriteFile(path, []byte(c.text), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := store.Apply(host.WorkspaceRequest{Kind: "tabSession", Tab: "tab-a"})
		if want := path + ": " + c.found; err == nil || err.Error() != want {
			t.Fatalf("a read of %s returned %v, want %q", c.text, err, want)
		}
	}
	for _, c := range []struct {
		req  host.WorkspaceRequest
		want string
	}{
		{host.WorkspaceRequest{Kind: "tabSession"}, "tab session requires a tab"},
		{host.WorkspaceRequest{Kind: "tabSession", Tab: "../tab-a"}, "invalid tab session tab: ../tab-a"},
		{host.WorkspaceRequest{Kind: "tabSessionPut", Tab: "tab-a", Regions: host.Record{}}, "invalid tab session of tab-a: empty"},
		{host.WorkspaceRequest{Kind: "tabSessionPut", Tab: "tab-a", Regions: host.Record{"page": map[string]any{"session": ""}}}, "invalid tab session region of tab-a: page"},
		{host.WorkspaceRequest{Kind: "tabSessionPut", Tab: "tab-a", Regions: host.Record{"page": map[string]any{"session": "A", "other": 1}}}, "invalid tab session region of tab-a: page"},
		{host.WorkspaceRequest{Kind: "tabSessionPut", Tab: "tab-a", Regions: host.Record{"page": "A"}}, "invalid tab session region of tab-a: page"},
	} {
		if _, err := store.Apply(c.req); err == nil || err.Error() != c.want {
			t.Fatalf("%+v returned %v, want %q", c.req, err, c.want)
		}
	}
}

// contract: workspace.tab-state.rejects-other-format, workspace.tab-state.rejects-invalid-entry
func TestTabStateRejectsOtherFormatAndInvalidEntries(t *testing.T) {
	config := t.TempDir()
	store := host.NewWorkspace(config)
	path := filepath.Join(config, "tab-state.json")
	if err := os.WriteFile(path, []byte(`{"format":2,"tabs":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := store.Apply(host.WorkspaceRequest{Kind: "tabStatePut", Tab: "tab-a", Entry: host.Record{"kept": true}})
	if want := path + ": tab state format 2 is not 1"; err == nil || err.Error() != want {
		t.Fatalf("a put into format 2 returned %v, want %q", err, want)
	}
	if data, _ := os.ReadFile(path); string(data) != `{"format":2,"tabs":{}}` {
		t.Fatalf("a refused put changed the file: %s", data)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		tab   string
		entry host.Record
		want  string
	}{
		{"", host.Record{"kept": true}, "tab state put requires a tab"},
		{"tab-a", host.Record{}, "invalid tab state entry of tab-a: empty"},
		{"tab-a", host.Record{"kept": false}, "invalid tab state entry of tab-a: kept"},
		{"tab-a", host.Record{"label": ""}, "invalid tab state entry of tab-a: label"},
		{"tab-a", host.Record{"state": map[string]any{"format": 0, "value": 1}}, "invalid tab state entry of tab-a: state"},
		{"tab-a", host.Record{"state": map[string]any{"format": 1}}, "invalid tab state entry of tab-a: state"},
		{"tab-a", host.Record{"other": 1}, "invalid tab state entry of tab-a: other"},
	} {
		_, err := store.Apply(host.WorkspaceRequest{Kind: "tabStatePut", Tab: c.tab, Entry: c.entry})
		if err == nil || err.Error() != c.want {
			t.Errorf("put %q %v returned %v, want %q", c.tab, c.entry, err, c.want)
		}
	}
}

// contract: workspace.settings.write-stores-current-form
func TestProjectSettingsWriteStoresTheCurrentNumberedForm(t *testing.T) {
	config := t.TempDir()
	w := host.NewWorkspace(config)
	earlier := t.TempDir()
	apply := func(req host.WorkspaceRequest) {
		t.Helper()
		if _, err := w.Apply(req); err != nil {
			t.Fatal(err)
		}
	}
	apply(host.WorkspaceRequest{Kind: "add", Project: host.Record{"id": "prj-earlier", "root": earlier, "identity": "1:4"}})
	if err := os.MkdirAll(filepath.Join(earlier, ".soksak"), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(earlier, ".soksak", "settings.json")
	if err := os.WriteFile(file, []byte(`{"gap":6}`), 0o644); err != nil {
		t.Fatal(err)
	}
	apply(host.WorkspaceRequest{Kind: "settings", ID: "prj-earlier", Patch: map[string]any{"gap": 12}})
	assertProjectFileForm(t, file, map[string]any{"format": float64(1), "gap": float64(12)})
	apply(host.WorkspaceRequest{Kind: "settings", ID: "prj-earlier", Remove: []string{"gap"}})
	assertProjectFileForm(t, file, map[string]any{"format": float64(1)})
	fresh := t.TempDir()
	apply(host.WorkspaceRequest{Kind: "add", Project: host.Record{"id": "prj-fresh", "root": fresh, "identity": "1:5"}})
	apply(host.WorkspaceRequest{Kind: "settings", ID: "prj-fresh", Patch: map[string]any{"gap": 3}})
	assertProjectFileForm(t, filepath.Join(fresh, ".soksak", "settings.json"), map[string]any{"format": float64(1), "gap": float64(3)})
}

func assertProjectFileForm(t *testing.T, path string, want map[string]any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s holds %v, want %v", path, got, want)
	}
}
