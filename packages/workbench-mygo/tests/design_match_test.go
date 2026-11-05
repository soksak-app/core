// Checks the places of the native workbench against the same elements of the page. Each value below was measured by element.rect on the
// Wails host, whose places equal those of the Tauri host, in a window of 1200 by 760.

package workbench_test

import (
	"math"
	"testing"

	"github.com/egoist/mygo/ui"
)

const designTolerance = 1

func designNear(a, b float32) bool { return math.Abs(float64(a-b)) <= designTolerance }

func designMiddle(box ui.Rect) float32 { return box.Y + box.H/2 }

func settingsSection(t *testing.T, section string) *shellFixture {
	t.Helper()
	f := opened(t)
	f.click("core.settings-modal.nav", "nav:"+section)
	return f
}

// The head of the card moves the card, as the header of the page does with its padding and its border.
func TestTheGripIsTheWholeHeadOfTheCard(t *testing.T) {
	f := opened(t)
	grip := f.box("core.settings-modal.grip", "")
	if !designNear(grip.X, 321) || !designNear(grip.Y, 73) || !designNear(grip.W, 558) || !designNear(grip.H, 44) {
		t.Fatalf("the grip is %+v, want 321,73 558x44", grip)
	}
}

// A row without a name keeps the empty name column of the grid of the page.
func TestAButtonOfARowWithoutANameStandsInTheControlColumn(t *testing.T) {
	f := settingsSection(t, "plugins")
	if manage := f.box("core.settings-modal.manage", "plugins:manage"); !designNear(manage.X, 611) {
		t.Fatalf("the manage button is at x %v, want 611", manage.X)
	}
	f = settingsSection(t, "sidebars")
	if create := f.box("core.settings-modal.create", "sets:create"); !designNear(create.X, 611) {
		t.Fatalf("the create button is at x %v, want 611", create.X)
	}
}

// The card ends with its content, with the padding of the pane and the border below the last row, as a card with max-height does.
func TestTheCardEndsWithItsContent(t *testing.T) {
	f := settingsSection(t, "sidebars")
	card, create := f.box("core.settings-modal.card", ""), f.box("core.settings-modal.create", "sets:create")
	if end, want := card.Y+card.H, create.Y+create.H+20; !designNear(end, want) {
		t.Fatalf("the card ends at %v and its last row at %v, want the card to end at %v", end, create.Y+create.H, want)
	}
}

// The slider of the page is as tall as its track.
func TestASliderIsAsTallAsItsTrack(t *testing.T) {
	f := opened(t)
	if slider := f.box("core.settings-modal.set", "size"); !designNear(slider.H, 3) {
		t.Fatalf("the slider is %v tall, want 3", slider.H)
	}
}

// Rows have one height, and a control stands in the middle of its row whatever its height, as in the grid of the page.
func TestAControlStandsInTheMiddleOfItsRow(t *testing.T) {
	f := opened(t)
	for _, pair := range [][2]string{{"font", "size"}, {"fullRule", "dim"}} {
		above, below := f.box("core.settings-modal.set", pair[0]), f.box("core.settings-modal.set", pair[1])
		if got := designMiddle(below) - designMiddle(above); !designNear(got, 30) {
			t.Fatalf("%s stands %v below %s, want 30", pair[1], got, pair[0])
		}
	}
}

// The two buttons of a set stand in a segment at the end of the row, and the caption takes the rest of it.
func TestTheButtonsOfASetAreASegment(t *testing.T) {
	f := settingsSection(t, "sidebars")
	line := f.box("core.settings-modal.set-caption", "")
	edit, remove := f.box("core.settings-modal.edit", "edit:set-1"), f.box("core.settings-modal.delete", "delete:set-1")
	if !designNear(edit.X, 774) || !designNear(edit.W, 41) || !designNear(edit.H, 22) {
		t.Fatalf("the edit button is %+v, want x 774, 41x22", edit)
	}
	if !designNear(remove.X, 817) || !designNear(remove.W, 41) || !designNear(remove.H, 22) {
		t.Fatalf("the delete button is %+v, want x 817, 41x22", remove)
	}
	if !designNear(line.X, 475) || !designNear(line.W, 284) {
		t.Fatalf("the caption is %+v, want x 475, width 284", line)
	}
}

// The element of a search is the whole field with its border.
func TestTheSearchOfPluginsIsTheWholeField(t *testing.T) {
	f := settingsSection(t, "plugins")
	search := f.box("core.settings-modal.search", "plugin-search")
	if !designNear(search.X, 611) || !designNear(search.W, 250) || !designNear(search.H, 29) {
		t.Fatalf("the search is %+v, want x 611, 250x29", search)
	}
}

// The field of a rename has the line height of the page.
func TestTheRenameFieldHasTheHeightOfThePage(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	doubleClick(f, f.box("core.project-tab", id))
	if field := f.box("core.rename.input", ""); !designNear(field.H, 19) {
		t.Fatalf("the field is %v tall, want 19", field.H)
	}
}

// The note of no results has the margins of a paragraph, and the grid gap stands between it and the card that adds a project.
func TestTheNoteOfNoResultsHasTheMarginsOfAParagraph(t *testing.T) {
	f := openedShell(t)
	f.run("core.projects.browse", nil)
	top := f.box("core.library.add", "").Y
	f.run("core.library.search", map[string]string{"query": "없는 이름"})
	note, add := f.box("core.library.no-results", ""), f.box("core.library.add", "")
	if !designNear(note.Y, top+12) {
		t.Fatalf("the note is at y %v, want %v", note.Y, top+12)
	}
	if !designNear(add.Y, note.Y+note.H+24) {
		t.Fatalf("the add card is at y %v, want %v", add.Y, note.Y+note.H+24)
	}
}

// The element of a sidebar holds its sections and not its status line.
func TestTheSidebarElementEndsAboveItsStatus(t *testing.T) {
	f := sidebarShell(t)
	side := f.box("core.sidebar", "left")
	status := f.box("core.sidebar.status", "left")
	if !designNear(side.Y+side.H, status.Y) {
		t.Fatalf("the sidebar ends at %v and its status starts at %v", side.Y+side.H, status.Y)
	}
}

// A sidebar without a set has no element of that name: the page names the element only when it draws a set.
func TestASidebarWithoutASetHasNoElement(t *testing.T) {
	f := sidebarShell(t)
	if !f.has("core.chrome.right", "") {
		t.Fatal("no button of the right sidebar")
	}
	if f.has("core.sidebar", "right") {
		t.Fatalf("the right sidebar without a set has an element at %+v", f.box("core.sidebar", "right"))
	}
}

// The close mark of a tab has the small text size and the tight line height of the page.
func TestTheCloseMarkOfATabHasTheHeightOfThePage(t *testing.T) {
	f, _, tab, _ := cardWithTwoTabs(t)
	if closing := f.box("core.card.tab-close", tab); !designNear(closing.H, 11) {
		t.Fatalf("the close mark is %v tall, want 11", closing.H)
	}
}

// A section name has the weight of the page, which is lighter than bold.
func TestASectionNameHasTheWeightOfThePage(t *testing.T) {
	f := sidebarShell(t)
	name := element(t, f.tester, "core.sidebar.section.name", "left/files.tree")
	var semibold float32
	ui.NewTester(func(c *ui.Context) {
		semibold, _ = c.MeasureText(0, ui.Span{Text: name.Label, Size: 11.5, Weight: 600})
	}, 400, 300).Frame()
	if !designNear(name.Bounds.W, semibold) || name.Bounds.W > semibold+0.5 {
		t.Fatalf("the name %q is %v wide, want %v", name.Label, name.Bounds.W, semibold)
	}
}

// A view of a project that the library covers has no place: the rectangle of its element would lead an audit and an input to what the
// window does not show. The page answers so, because the surface is not in the seated placement.
func TestAViewUnderTheLibraryHasNoPlace(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.native.on", map[string]any{"name": "exposure-request"})
	r.call(surface, "runtime.native.call", map[string]any{"name": "registered", "payload": map[string]any{"kind": "element", "name": "terminal.view"}})
	ask := func(id int) map[string]any {
		t.Helper()
		r.mu.Lock()
		seen := len(r.pushed)
		r.mu.Unlock()
		r.ask(id, "element.rect", `{"name": "terminal.view"}`)
		var pushed map[string]any
		r.f.pending.until(t, func() bool {
			r.mu.Lock()
			defer r.mu.Unlock()
			if len(r.pushed) <= seen {
				return false
			}
			pushed = r.pushed[seen]
			return true
		})
		data := pushed["data"].(map[string]any)
		r.call(surface, "runtime.native.call", map[string]any{"name": "exposureReply", "payload": map[string]any{"id": data["id"],
			"result": map[string]any{"x": 0, "y": 0, "width": 10, "height": 20, "zoom": 1}}})
		return r.answer(id)
	}
	if reply := ask(9); reply["error"] != nil {
		t.Fatalf("the shown view answers %v", reply)
	}
	r.f.run("core.projects.browse", nil)
	reply := ask(10)
	failure, _ := reply["error"].(map[string]any)
	if failure == nil || failure["message"] != "surface "+surface+" has no valid applied frame" {
		t.Fatalf("the view under the library answers %v", reply)
	}
}
