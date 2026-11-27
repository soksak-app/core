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

func TestTheSearchOfTheHomeTakesTheFocusAndItsKeys(t *testing.T) {
	f := newShell(t, &storedHost{})
	if !f.has("core.home.search", "") {
		t.Fatalf("the project home has no search; the texts are %q", f.tester.Texts())
	}
	f.run("core.home.search.focus", nil)
	if !f.tester.Focused("프로젝트 찾기") {
		t.Fatal("core.home.search.focus left the search without the focus")
	}
	f.tester.Type("a")
	f.settle()
	if got := status[homeRead](t, f, "core.home").Query; got != "a" {
		t.Fatalf("the query of the home is %v", got)
	}
}

func TestTheSearchFocusNeedsTheHome(t *testing.T) {
	f := openedShell(t)
	failure := make(chan error, 1)
	f.shell.Registry().RunLater("core.home.search.focus", nil, func(_ any, err error) { failure <- err })
	f.settle()
	if err := <-failure; err == nil || err.Error() != "the project home is not shown" {
		t.Fatalf("core.home.search.focus failed with %v", err)
	}
}

// A command answers after the frame that shows its change (docs/spec/exposure.md#registration): core.projects.browse, the
// command of Command+K, answers when the frame that draws the project home ran, so a request that the caller sends after the answer
// finds the elements of the project home.

// A command whose run changes nothing answers at once, without asking for a frame: core.home.search with the query that the home holds.

func TestACommandAnswersAfterTheFrameThatShowsItsChange(t *testing.T) {
	f := openedShell(t)
	if f.has("core.home.search", "") {
		t.Fatal("the workspace already shows the project home")
	}
	answered := false
	var focused error
	f.shell.Registry().RunLater("core.projects.browse", nil, func(_ any, err error) {
		if err != nil {
			t.Errorf("core.projects.browse failed: %v", err)
		}
		answered = true
		_, focused = f.shell.Registry().Answer("command.run",
			json.RawMessage(`{"name":"core.focus.set","params":{"name":"core.home.search","index":0}}`), nil)
	})
	if answered {
		t.Fatal("core.projects.browse answered before a frame drew the project home")
	}
	f.settle()
	if !answered {
		t.Fatal("core.projects.browse did not answer after the frame that drew the project home")
	}
	if focused != nil {
		t.Fatalf("a request after the answer of core.projects.browse failed: %v", focused)
	}
}

func TestACommandThatChangesNothingAnswersAtOnce(t *testing.T) {
	f := openedShell(t)
	frames := f.frames
	answered := false
	f.shell.Registry().RunLater("core.home.search", json.RawMessage(`{"query":""}`), func(_ any, err error) {
		if err != nil {
			t.Errorf("core.home.search failed: %v", err)
		}
		answered = true
	})
	if f.frames != frames {
		t.Fatalf("core.home.search asked for %d frames", f.frames-frames)
	}
	if !answered {
		t.Fatal("core.home.search, which changed nothing, did not answer at once")
	}
	f.settle()
}
