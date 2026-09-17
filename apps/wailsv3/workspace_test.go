package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestSettingsFilesAndInheritance(t *testing.T) {
	root := t.TempDir()
	config := t.TempDir()
	store := &Workspace{directory: config}
	apply := func(req WorkspaceRequest) any {
		t.Helper()
		result, err := store.Apply(req)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	apply(WorkspaceRequest{Kind: "add", Project: Record{"id": "prj-test", "root": root, "identity": "1:2"}})
	apply(WorkspaceRequest{Kind: "settings", Patch: Record{"mode": "light", "gap": 6, "projectOpening": "windows"}})
	apply(WorkspaceRequest{Kind: "settings", ID: "prj-test", Patch: Record{"gap": 12}})
	var project Record
	if err := readJSON(filepath.Join(root, ".soksak", "settings.json"), &project); err != nil {
		t.Fatal(err)
	}
	if len(project) != 1 || project["gap"] != float64(12) {
		t.Fatalf("project file includes inherited settings: %v", project)
	}
	reopened := &Workspace{directory: config}
	snapshot, err := reopened.Apply(WorkspaceRequest{Kind: "snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	got := snapshot.(Record)
	if got["common"].(Record)["mode"] != "light" || got["projects"].([]Record)[0]["settings"].(Record)["gap"] != float64(12) {
		t.Fatalf("settings did not survive reopening: %v", got)
	}
	apply(WorkspaceRequest{Kind: "settings", ID: "prj-test", Remove: []string{"gap"}})
	project = nil
	if err := readJSON(filepath.Join(root, ".soksak", "settings.json"), &project); err != nil {
		t.Fatal(err)
	}
	if len(project) != 0 {
		t.Fatal("reset did not remove the override")
	}
	if _, err := store.Apply(WorkspaceRequest{Kind: "settings", ID: "prj-test", Patch: Record{"projectOpening": "tabs"}}); err == nil {
		t.Fatal("project opening policy accepted a folder override")
	}
	if err := os.WriteFile(filepath.Join(config, "settings.json"), []byte("null"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(WorkspaceRequest{Kind: "settings", Patch: Record{"gap": 2}}); err == nil {
		t.Fatal("invalid settings were overwritten")
	}
	data, _ := os.ReadFile(filepath.Join(config, "settings.json"))
	if string(data) != "null" {
		t.Fatal("invalid file was changed")
	}
}

func TestConcurrentSettingsAndProjectOrder(t *testing.T) {
	store := &Workspace{directory: t.TempDir()}
	for _, id := range []string{"first", "second", "third"} {
		if _, err := store.Apply(WorkspaceRequest{Kind: "add", Project: Record{"id": id, "identity": id, "root": t.TempDir()}}); err != nil {
			t.Fatal(err)
		}
	}
	var calls sync.WaitGroup
	for _, key := range []string{"mode", "theme", "rail"} {
		calls.Add(1)
		go func(key string) {
			defer calls.Done()
			if _, err := store.Apply(WorkspaceRequest{Kind: "settings", Patch: Record{key: key}}); err != nil {
				t.Error(err)
			}
		}(key)
	}
	calls.Wait()
	if _, err := store.Apply(WorkspaceRequest{Kind: "move", ID: "third", Delta: -2}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.Apply(WorkspaceRequest{Kind: "snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	got := snapshot.(Record)
	if len(got["common"].(Record)) != 3 {
		t.Fatal("concurrent updates lost settings")
	}
	projects := got["projects"].([]Record)
	if projects[0]["id"] != "third" {
		t.Fatal("saved project order is incorrect")
	}
	if _, err := store.Apply(WorkspaceRequest{Kind: "remove", ID: "third"}); err != nil {
		t.Fatal(err)
	}
	snapshot, _ = store.Apply(WorkspaceRequest{Kind: "snapshot"})
	if snapshot.(Record)["projects"].([]Record)[0]["id"] != "first" {
		t.Fatal("first remaining project is incorrect")
	}
}

func TestFolderIdentity(t *testing.T) {
	host := &Host{}
	root := t.TempDir()
	link := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	first, err := host.ProjectFolder(root)
	if err != nil {
		t.Fatal(err)
	}
	alias, err := host.ProjectFolder(filepath.Join(link, "."))
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
	if _, err := host.ProjectFolder(file); err == nil {
		t.Fatal("a file was accepted as a project directory")
	}
}
