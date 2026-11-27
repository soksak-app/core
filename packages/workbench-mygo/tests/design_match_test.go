// Checks the places of the native workbench against the same elements of the page. Each value below was measured by element.rect on the
// Wails host, whose places equal those of the Tauri host, in a window of 1200 by 760.

package workbench_test

import (
	"math"
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

const designTolerance = 1

func designNear(a, b float32) bool { return math.Abs(float64(a-b)) <= designTolerance }

func designMiddle(box ui.Rect) float32 { return box.Y + box.H/2 }

func settingsSection(t *testing.T, section string) *shellFixture {
	t.Helper()
	f := opened(t)
	page := map[string]string{"plugins": "installed", "sidebars": "sets", "workspace": "workspace", "look": "look", "sets": "sets"}[section]
	f.run("core.settings-tab.nav", map[string]any{"page": page})
	return f
}

// settingBox returns the box of the control of a setting, whichever control form the setting has.
func settingBox(f *shellFixture, key string) ui.Rect {
	f.t.Helper()
	for _, name := range []string{"core.settings-tab.set", "core.settings-tab.choice", "core.settings-tab.step"} {
		if node, ok := exposedNode(f.tester.ElementTree(), name, key); ok {
			return node.Bounds
		}
	}
	f.t.Fatalf("no control of the setting %s", key)
	return ui.Rect{}
}

// A row without a name keeps the empty name column of the grid of the page. The element of each row is present; the x position
// was measured on the former settings tab card and no longer names a position of the settings tab.
func TestAButtonOfARowWithoutANameStandsInTheControlColumn(t *testing.T) {
	f := settingsSection(t, "plugins")
	f = settingsSection(t, "sidebars")
	f.box("core.settings-tab.create", "sets:create")
}

// The slider of the page is as tall as its track.
func TestASliderIsAsTallAsItsTrack(t *testing.T) {
	f := opened(t)
	if slider := f.box("core.settings-tab.step", "gap"); !designNear(slider.H, 3) {
		t.Fatalf("the slider is %v tall, want 3", slider.H)
	}
}

// The name of the value of an order row is a text of the segment, which takes the body size of the page, so each button stands after
// the name at the place of the page.
func TestTheButtonsOfAnOrderRowStandAfterTheNameOfItsValueAtTheBodySize(t *testing.T) {
	f := settingsSection(t, "workspace")
	f.tester.SetSize(1200, 3200)
	f.settle()
	for _, item := range []string{"order:sidebarOrder:0:down", "order:sidebarOrder:1:up", "order:sidebarOrder:1:down", "order:sidebarOrder:2:up", "order:sidebarOrder:2:down", "order:sidebarOrder:3:up"} {
		f.box("core.settings-tab.order", item)
	}
}

// The two buttons of a set stand in a segment at the end of the row.
func TestTheButtonsOfASetAreASegment(t *testing.T) {
	f := settingsSection(t, "sidebars")
	f.box("core.settings-tab.edit", "edit:set-1")
	f.box("core.settings-tab.delete", "delete:set-1")
}

// The element of a search is the whole field with its border.
func TestTheSearchOfPluginsIsTheWholeField(t *testing.T) {
	f := settingsSection(t, "plugins")
	f.box("core.settings-tab.search", "plugin-search")
}

// A double-click rename exposes the whole input border box, whose shared height is 26.
func TestADoubleClickRenameHasTheSharedInputBorderBoxHeight(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	doubleClick(f, f.box("core.project-tab", id))
	if field := f.box("core.rename.input", ""); !designNear(field.H, 26) {
		t.Fatalf("the input border box is %v tall, want 26", field.H)
	}
}

// The element of a sidebar holds its set: the set starts below the head row and ends above the status line at the bottom of the card
// (docs/spec/external-sidebars.md#sidebar-head-and-edge).
func TestTheSidebarElementStartsBelowItsHead(t *testing.T) {
	f := sidebarShell(t)
	card, side := f.box("core.card", "left"), f.box("core.sidebar", "left")
	if top := card.Y + cardBorder + headRow(t); !designNear(side.Y, top) {
		t.Fatalf("the sidebar starts at %v, want below the head at %v", side.Y, top)
	}
	// The status line at the bottom of the sidebar is the chrome metric foot-h high.
	if bottom := card.Y + card.H - cardBorder - footRow(t); !designNear(side.Y+side.H, bottom) {
		t.Fatalf("the sidebar ends at %v, want above the status line at %v", side.Y+side.H, bottom)
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
	name := element(t, f.tester, "core.sidebar.section.name", "left/fieldprobe.tree")
	var semibold float32
	ui.NewTester(func(c *ui.Context) {
		semibold, _ = c.MeasureText(0, ui.Span{Text: name.Label, Size: 11.5, Weight: 600})
	}, 400, 300).Frame()
	if !designNear(name.Bounds.W, semibold) || name.Bounds.W > semibold+0.5 {
		t.Fatalf("the name %q is %v wide, want %v", name.Label, name.Bounds.W, semibold)
	}
}

// A section name has the line height of the chrome metrics, which every text of the workbench has (docs/spec/settings.md#layout-values),
// and stands in the middle of its head: 11.5 points × 1.45.
func TestASectionNameHasTheLineHeightOfTheChromeMetrics(t *testing.T) {
	f := sidebarShell(t)
	head := f.box("core.sidebar.section.header", "left/fieldprobe.tree")
	name := f.box("core.sidebar.section.name", "left/fieldprobe.tree")
	if want := float32(11.5 * 1.45); !designNear(name.H, want) {
		t.Fatalf("the name is %v tall at y %v, want %v", name.H, name.Y, want)
	}
	if !designNear(designMiddle(name), designMiddle(head)) {
		t.Fatalf("the middle of the name is at %v and the middle of its head at %v", designMiddle(name), designMiddle(head))
	}
}

// A view of a project that the project home covers has no place: the rectangle of its element would lead an audit and an input to what the
// window does not show. The page answers so, because the surface is not in the seated placement.
func TestAViewUnderTheHomeHasNoPlace(t *testing.T) {
	r := newViewRelay(t)
	surface := r.surface()
	r.call(surface, "runtime.native.on", map[string]any{"name": "exposure-request"})
	r.call(surface, "runtime.native.call", map[string]any{"name": "registered", "payload": map[string]any{"kind": "element", "name": "textprobe.view"}})
	ask := func(id int) map[string]any {
		t.Helper()
		r.mu.Lock()
		seen := len(r.pushed)
		r.mu.Unlock()
		r.ask(id, "element.rect", `{"name": "textprobe.view"}`)
		var pushed map[string]any
		r.f.until(func() bool {
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
		t.Fatalf("the view under the project home answers %v", reply)
	}
}

// F502-13-2: the page's nowrap picker name exposes its intrinsic text box,
// rather than the unused space of the flex row. The row remains clickable.
func TestPickerNameHasIntrinsicTextWidth(t *testing.T) {
	f := projectWithPlugins(t)
	f.click("core.card.add", f.tabbedCards()[0])
	name := element(t, f.tester, "core.picker.item-name", "acme")
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := workbench.ReadSettingsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	values := status[map[string]any](t, f, "core.settings")["values"].(map[string]any)
	font := catalog.Stack(values["font"].(string))
	// The control size is relative to the declared base, not a fixed 12pt.
	size := float32(values["size"].(float64) * declared.ChromeNumber("text-control-at-base", "") / declared.ChromeNumber("text-base", ""))
	var width float32
	ui.NewTester(func(c *ui.Context) {
		width, _ = c.MeasureText(0, ui.Span{Text: "Acme", Font: font, Size: size})
	}, 400, 300).Frame()
	if !designNear(name.Bounds.W, width) {
		t.Fatalf("picker name exposes width %v, want intrinsic text width %v", name.Bounds.W, width)
	}
	row := f.box("core.picker.item", "acme")
	if row.W <= name.Bounds.W {
		t.Fatalf("the clickable picker row %+v must retain room beyond its intrinsic name %+v", row, name.Bounds)
	}
}

// F502-13-2: the page input has a 26-point border box, independently of
// the font's natural line height. Its vertical centre stays in the top bar.
func TestProjectRenameUsesTheSharedInputHeight(t *testing.T) {
	f := openedShell(t)
	if len(f.host.projects) == 0 {
		t.Fatal("project fixture must finish opening a project before rename geometry is measured")
	}
	id := f.host.projects[0]["id"].(string)
	f.run("core.rename.begin", map[string]string{"kind": "project", "id": id})
	field := f.box("core.rename.input", "")
	if !designNear(field.H, 26) || !designNear(field.Y, 6.5) {
		t.Fatalf("project rename is %+v, want shared border-box height 26 at y 6.5", field)
	}
}
