// The tabs of the projects: one for each project of the workspace, ordered by a drag, in the first row or in the column of the left mode.
package workbench_test

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// fixtureHeight is the height of the window of the fixture.
const fixtureHeight float32 = 800

// twoProjects opens two projects and returns their ids, the shown one last.
func twoProjects(t *testing.T) (*shellFixture, string, string) {
	t.Helper()
	f := openedShell(t)
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/beta"})
	f.run("core.library.form.submit", nil)
	f.settle()
	return f, f.host.projects[0]["id"].(string), f.host.projects[1]["id"].(string)
}

func TestEveryProjectHasATab(t *testing.T) {
	f, first, second := twoProjects(t)
	if !f.has("core.project-tab", first) || !f.has("core.project-tab", second) {
		t.Fatalf("the tabs of %s and %s are not both drawn", first, second)
	}
	f.click("core.project-tab", first)
	if got := status[struct{ ID string }](t, f, "core.project"); got.ID != first {
		t.Fatalf("the tab shows %s, not %s", got.ID, first)
	}
}

func dragBetween(f *shellFixture, from, to ui.Rect) {
	x, y := from.X+from.W/2, from.Y+from.H/2
	f.tester.Move(x, y)
	f.tester.Press(x, y)
	f.tester.Frame()
	endX, endY := to.X+to.W/2, to.Y+to.H/2
	for i := float32(1); i <= 4; i++ {
		f.tester.Move(x+(endX-x)*i/4, y+(endY-y)*i/4)
		f.tester.Frame()
	}
	f.tester.Release(endX, endY)
	f.settle()
}

func TestADragOrdersTheProjectTabs(t *testing.T) {
	f, first, second := twoProjects(t)
	dragBetween(f, f.box("core.project-tab", second), f.box("core.project-tab", first))
	if f.host.projects[0]["id"] != second || f.host.projects[1]["id"] != first {
		t.Fatalf("the store holds %v then %v", f.host.projects[0]["id"], f.host.projects[1]["id"])
	}
	if f.box("core.project-tab", second).X >= f.box("core.project-tab", first).X {
		t.Fatal("the tabs did not change places")
	}
}

func TestTheLeftColumnHoldsTheProjectTabs(t *testing.T) {
	f, first, second := twoProjects(t)
	if f.has("core.projects.column", "") {
		t.Fatal("a column in the top mode")
	}
	top := f.box("core.card", f.cardsOf()[0]["id"].(string))
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"projectTabs": "left"}})
	f.settle()
	column := f.box("core.projects.column", "")
	if column.X != 0 || column.W != 64 {
		t.Fatalf("the column is at %+v", column)
	}
	if column.Y+column.H != fixtureHeight {
		t.Fatalf("the column ends at %v, not at the bottom %v", column.Y+column.H, fixtureHeight)
	}
	for _, id := range []string{first, second} {
		tab := f.box("core.project-tab", id)
		if tab.X < column.X || tab.X+tab.W > column.X+column.W || tab.H != 36 {
			t.Fatalf("the tab %s is at %+v in the column %+v", id, tab, column)
		}
	}
	add := f.box("core.project-tab.add", "")
	if add.H != 24 || add.X < column.X || add.X+add.W > column.X+column.W {
		t.Fatalf("the add button is at %+v", add)
	}
	card := f.box("core.card", f.cardsOf()[0]["id"].(string))
	if card.X != top.X+column.W || card.Y != top.Y {
		t.Fatalf("the card is at %+v, and at %+v before", card, top)
	}
	space := f.box("core.space-tab", "")
	if space.X < column.X+column.W {
		t.Fatalf("the space tab is at %+v, under the column %+v", space, column)
	}
	f.run("core.projects.browse", nil)
	if f.has("core.projects.column", "") {
		t.Fatal("a column in the library")
	}
}

func TestARenameFitsTheColumn(t *testing.T) {
	f, first, _ := twoProjects(t)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"projectTabs": "left"}})
	f.settle()
	f.run("core.rename.begin", map[string]string{"kind": "project", "id": first})
	column, field := f.box("core.projects.column", ""), f.box("core.rename.input", "")
	if field.X < column.X || field.X+field.W > column.X+column.W {
		t.Fatalf("the field %+v leaves the column %+v", field, column)
	}
}

func TestADragOrdersTheTabsOfTheColumn(t *testing.T) {
	f, first, second := twoProjects(t)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"projectTabs": "left"}})
	f.settle()
	dragBetween(f, f.box("core.project-tab", second), f.box("core.project-tab", first))
	if f.host.projects[0]["id"] != second {
		t.Fatalf("the store holds %v first", f.host.projects[0]["id"])
	}
	if f.box("core.project-tab", second).Y >= f.box("core.project-tab", first).Y {
		t.Fatal("the tabs did not change places")
	}
}

// In the column the close button shows only on the tab under the pointer or with the focus.
func TestTheFocusShowsTheCloseButtonOfTheColumn(t *testing.T) {
	f, first, _ := twoProjects(t)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"projectTabs": "left"}})
	f.settle()
	f.tester.Move(600, 400)
	f.tester.Frame()
	mark := f.box("core.project-tab.close", first)
	x, y := mark.X+mark.W/2, mark.Y+mark.H/2 // The middle of the mark, which the ring around the button does not reach.
	before := f.pixelOf(x, y)
	f.run("core.focus.set", map[string]any{"name": "core.project-tab.close", "index": 0})
	f.tester.Key(0, ui.KeyTab)
	f.tester.Key(ui.Shift, ui.KeyTab)
	f.settle()
	if f.pixelOf(x, y) == before {
		t.Fatal("the focus did not show the close button")
	}
}
