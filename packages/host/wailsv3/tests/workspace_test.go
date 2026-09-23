package host_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

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
	if len(project) != 1 || project["gap"] != float64(12) {
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
	if len(project) != 0 {
		t.Fatal("reset did not remove the override")
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
	if _, err := store.Apply(host.WorkspaceRequest{Kind: "move", ID: "third", Delta: -2}); err != nil {
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

// readJSON 은 path 의 JSON 객체를 into 에 읽는다.
func readJSON(t *testing.T, path string, into *host.Record) error {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, into)
}
