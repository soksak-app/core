package workbench_test

import (
	"encoding/json"
	"slices"
	"testing"
)

// openingShell is a shell that shows the project alpha, with the opening mode mode.
func openingShell(t *testing.T, mode string) *shellFixture {
	t.Helper()
	f := newShell(t, &storedHost{common: map[string]any{"projectOpening": mode}})
	f.openFolder("/work/alpha")
	return f
}

// openFolder opens the folder root as a project.
func (f *shellFixture) openFolder(root string) {
	f.t.Helper()
	if err := f.finish("core.project.open", map[string]string{"root": root}); err != nil {
		f.t.Fatal(err)
	}
}

// projectOf returns the identifier of the project at the folder root.
func (f *shellFixture) projectOf(root string) string {
	f.t.Helper()
	for _, project := range f.host.projects {
		if project["root"] == root {
			return project["id"].(string)
		}
	}
	f.t.Fatalf("no project at %s", root)
	return ""
}

func (f *shellFixture) lastOpen() projectOpenRequest {
	f.t.Helper()
	if len(f.host.opens) == 0 {
		f.t.Fatal("no project was opened")
	}
	return f.host.opens[len(f.host.opens)-1]
}

// The first project of a window opens in place in both modes, and the mode decides the window of the second.
func TestTheOpeningModeDecidesTheWindowOfASecondProject(t *testing.T) {
	for _, mode := range []struct {
		value    string
		separate bool
		windows  int
		shown    string
	}{
		{"windows", true, 1, "/work/alpha"},
		{"tabs", false, 0, "/work/beta"},
	} {
		t.Run(mode.value, func(t *testing.T) {
			f := openingShell(t, mode.value)
			alpha := f.projectOf("/work/alpha")
			if got := f.lastOpen(); got.ID != alpha || got.Separate != mode.separate {
				t.Fatalf("the first open is %+v", got)
			}
			if f.host.windows != 0 || f.host.located != alpha {
				t.Fatalf("after the first open there are %d more windows and the window shows %s", f.host.windows, f.host.located)
			}
			f.openFolder("/work/beta")
			beta := f.projectOf("/work/beta")
			if got := f.lastOpen(); got.ID != beta || got.Separate != mode.separate {
				t.Fatalf("the second open is %+v", got)
			}
			if f.host.windows != mode.windows {
				t.Fatalf("the second open made %d windows, want %d", f.host.windows, mode.windows)
			}
			if want := f.projectOf(mode.shown); f.host.located != want {
				t.Fatalf("the window shows %s, want %s", f.host.located, want)
			}
			if f.host.project(beta)["lastOpened"] == nil {
				t.Fatal("the second project keeps no time of its opening")
			}
		})
	}
}

// A project with a window makes no other: selecting it reuses the window that it has, and the window of the request keeps its project.
func TestReopeningAProjectReusesItsWindow(t *testing.T) {
	f := openingShell(t, "windows")
	f.openFolder("/work/beta")
	alpha, beta := f.projectOf("/work/alpha"), f.projectOf("/work/beta")
	f.run("core.project.activate", map[string]string{"id": beta})
	if f.host.windows != 1 || f.host.located != alpha {
		t.Fatalf("there are %d more windows and the window shows %s", f.host.windows, f.host.located)
	}
	f.run("core.project.activate", map[string]string{"id": alpha})
	if f.host.windows != 1 || f.host.located != alpha {
		t.Fatalf("there are %d more windows and the window shows %s", f.host.windows, f.host.located)
	}
}

// A project that opens in another window takes this window from the library back to its own project, as the page does.
func TestAProjectInAnotherWindowEndsTheLibrary(t *testing.T) {
	f := openingShell(t, "windows")
	f.openFolder("/work/beta")
	f.run("core.projects.browse", nil)
	if !f.has("core.library.return", "") {
		t.Fatal("the library is not shown")
	}
	f.run("core.library.open", map[string]string{"id": f.projectOf("/work/beta")})
	if f.has("core.library.return", "") {
		t.Fatal("the library stays")
	}
	if f.host.located != f.projectOf("/work/alpha") {
		t.Fatalf("the window shows %s", f.host.located)
	}
}

// Closing the shown project moves to a project of this window and leaves the project that another window shows.
func TestClosingTheShownProjectLeavesAProjectOfAnotherWindow(t *testing.T) {
	f := openingShell(t, "windows")
	f.openFolder("/work/beta")
	opens := len(f.host.opens)
	f.run("core.project.close", map[string]string{"id": f.projectOf("/work/alpha")})
	if len(f.host.opens) != opens || f.host.located != "" {
		t.Fatalf("the window opened %v and shows %q", f.host.opens[opens:], f.host.located)
	}
}

var (
	someGeometry  = map[string]any{"x": float64(10), "y": float64(20), "width": float64(800), "height": float64(600)}
	otherGeometry = map[string]any{"x": float64(30), "y": float64(40), "width": float64(900), "height": float64(700)}
)

func wantGeometry(t *testing.T, f *shellFixture, id string, want any) {
	t.Helper()
	got, wanted := mustJSON(t, f.host.project(id)["geometry"]), mustJSON(t, want)
	if got != wanted {
		t.Fatalf("the project %s stores the geometry %s, want %s", id, got, wanted)
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

// Leaving a project stores the geometry of its window, the next open of the project carries it, and an unchanged geometry stores nothing.
func TestAProjectKeepsTheGeometryOfItsWindow(t *testing.T) {
	f := openingShell(t, "tabs")
	f.openFolder("/work/beta")
	alpha, beta := f.projectOf("/work/alpha"), f.projectOf("/work/beta")
	if got := f.lastOpen().Geometry; string(got) != "null" {
		t.Fatalf("a project without a stored geometry opens with %s", got)
	}
	f.host.geometry = someGeometry
	f.run("core.project.activate", map[string]string{"id": alpha})
	wantGeometry(t, f, beta, someGeometry)
	f.run("core.project.activate", map[string]string{"id": beta})
	wantGeometry(t, f, alpha, someGeometry)
	if got, want := string(f.lastOpen().Geometry), mustJSON(t, someGeometry); got != want {
		t.Fatalf("the project opens with %s, want %s", got, want)
	}
	delete(f.host.project(beta), "geometry")
	f.run("core.project.activate", map[string]string{"id": alpha})
	wantGeometry(t, f, beta, nil)
	f.host.geometry = otherGeometry
	f.run("core.project.activate", map[string]string{"id": beta})
	wantGeometry(t, f, alpha, otherGeometry)
}

// The library and a window without an ordinary size store nothing.
func TestAGeometryWithoutItsProjectStaysUnstored(t *testing.T) {
	f := openingShell(t, "tabs")
	f.openFolder("/work/beta")
	beta := f.projectOf("/work/beta")
	f.run("core.project.activate", map[string]string{"id": f.projectOf("/work/alpha")})
	wantGeometry(t, f, beta, nil)
	f.host.geometry = someGeometry
	f.run("core.projects.browse", nil)
	f.run("core.library.open", map[string]string{"id": beta})
	wantGeometry(t, f, f.projectOf("/work/alpha"), nil)
}

// A closing window stores its geometry before the host ends it.
func TestAClosingWindowStoresItsGeometry(t *testing.T) {
	f := openingShell(t, "windows")
	f.host.geometry = someGeometry
	f.shell.Event("project-close-request", nil)
	f.settle()
	wantGeometry(t, f, f.projectOf("/work/alpha"), someGeometry)
	state, closing := slices.Index(f.host.calls, "windowState"), slices.Index(f.host.calls, "windowClose")
	if state < 0 || closing < state {
		t.Fatalf("the calls are %v", f.host.calls)
	}
}
