// The core names of the library, each through its command and through the control that a person uses.
package workbench_test

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestTheFolderCommandAnswersWithTheFolderOfTheHost(t *testing.T) {
	f := newShell(t, &storedHost{})
	answer, err := f.answerLater("core.folder.create", map[string]string{"parent": "/work", "name": "gamma"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"root":"/work/gamma","identity":"identity of /work/gamma"}`; string(encoded) != want {
		t.Fatalf("the answer is %s, want %s", encoded, want)
	}
	if len(f.host.projects) != 0 {
		t.Fatalf("the command made a project: %v", f.host.projects)
	}
}

func TestTheFolderCommandPassesOnTheRefusalOfTheHost(t *testing.T) {
	refused := errors.New("the folder exists")
	f := newShell(t, &storedHost{createRefused: refused})
	if _, err := f.answerLater("core.folder.create", map[string]string{"parent": "/work", "name": "gamma"}); err == nil || !strings.Contains(err.Error(), refused.Error()) {
		t.Fatalf("the command answered %v", err)
	}
}

func TestTheSearchFocusFollowsThePageOfTheLibrary(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.run("core.library.search.focus", nil)
	f.tester.Frame()
	if !f.tester.Focused("프로젝트 검색") {
		t.Fatal("the project search has no focus")
	}
	f.run("core.library.page", map[string]string{"page": "plugins"})
	f.run("core.library.search.focus", nil)
	f.tester.Frame()
	if !f.tester.Focused("플러그인 검색") {
		t.Fatal("the plugin search has no focus")
	}
}

func TestTheSearchFocusRefusesOutsideTheLibrary(t *testing.T) {
	f := openedShell(t)
	if _, err := f.answerLater("core.library.search.focus", nil); err == nil || err.Error() != "the library is not shown" {
		t.Fatalf("the command answered %v", err)
	}
}

func TestTheShortcutFocusesTheSearch(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.tester.Key(ui.Cmd, ui.KeyK)
	f.settle()
	if !f.tester.Focused("프로젝트 검색") {
		t.Fatal("the project search has no focus")
	}
}

func TestAnEmptyLibrarySaysHowToStart(t *testing.T) {
	f := newShell(t, &storedHost{})
	if !f.has("core.library.empty", "") {
		t.Fatalf("no empty note; the texts are %q", f.tester.Texts())
	}
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	if !f.has("core.library.empty", "") {
		t.Fatal("the form hid the empty note")
	}
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	f.run("core.projects.browse", nil)
	if f.has("core.library.empty", "") {
		t.Fatal("the note stays with a project in the library")
	}
}

func TestTheSearchFieldFiltersTheLibrary(t *testing.T) {
	f := openedShell(t)
	f.run("core.projects.browse", nil)
	f.click("core.library.search", "")
	f.tester.Type("없는 이름")
	f.settle()
	if !f.has("core.library.no-results", "") || !slices.Contains(f.tester.Texts(), "일치하는 프로젝트가 없습니다.") {
		t.Fatalf("no note of no results; the texts are %q", f.tester.Texts())
	}
	f.run("core.library.search", map[string]string{"query": "alpha"})
	if f.has("core.library.no-results", "") {
		t.Fatal("the note stays with a match")
	}
}
