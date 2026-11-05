package workbench_test

import (
	"encoding/json"
	"testing"
)

func TestClosingAProjectAnswersThatItClosed(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	if got := f.answerText("core.project.close", map[string]string{"id": id}); got != `{"closed":true}` {
		t.Fatalf("core.project.close answered %s", got)
	}
}

func TestClosingAnUnknownProjectFails(t *testing.T) {
	f := openedShell(t)
	failure := make(chan error, 1)
	f.shell.Registry().RunLater("core.project.close", json.RawMessage(`{"id":"none"}`), func(_ any, err error) { failure <- err })
	f.settle()
	if err := <-failure; err == nil || err.Error() != "Unknown project: none" {
		t.Fatalf("core.project.close failed with %v", err)
	}
}

func TestAddingASpaceAnswersItsIdAndTitle(t *testing.T) {
	f := openedShell(t)
	var space struct{ ID, Title string }
	if err := json.Unmarshal([]byte(f.answerText("core.space.add", nil)), &space); err != nil {
		t.Fatal(err)
	}
	if space.ID == "" || space.Title == "" {
		t.Fatalf("core.space.add answered %+v", space)
	}
}

func TestTheSearchOfTheLibraryTakesTheFocusAndItsKeys(t *testing.T) {
	f := newShell(t, &storedHost{})
	if !f.has("core.library.search", "") {
		t.Fatalf("the library has no search; the texts are %q", f.tester.Texts())
	}
	f.run("core.library.search.focus", nil)
	if !f.tester.Focused("프로젝트 검색") {
		t.Fatal("core.library.search.focus left the search without the focus")
	}
	f.tester.Type("a")
	f.settle()
	if got := status[map[string]any](t, f, "core.library")["query"]; got != "a" {
		t.Fatalf("the query of the library is %v", got)
	}
}

func TestTheSearchOfThePluginPageTakesTheFocus(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.run("core.library.page", map[string]string{"page": "plugins"})
	f.run("core.library.search.focus", nil)
	if !f.tester.Focused("플러그인 검색") {
		t.Fatal("core.library.search.focus left the search of the plugin page without the focus")
	}
}

func TestTheSearchFocusNeedsTheLibrary(t *testing.T) {
	f := openedShell(t)
	failure := make(chan error, 1)
	f.shell.Registry().RunLater("core.library.search.focus", nil, func(_ any, err error) { failure <- err })
	f.settle()
	if err := <-failure; err == nil || err.Error() != "the library is not shown" {
		t.Fatalf("core.library.search.focus failed with %v", err)
	}
}
