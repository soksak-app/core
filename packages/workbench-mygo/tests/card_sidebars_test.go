// The sidebars of a card: the choice of each side, its place around the content, its grip and its header control
// (docs/spec/example-model.md).
package workbench_test

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// cardSidebar is a shown project whose card shows the set of the installed files on side. It returns the card.
func cardSidebar(t *testing.T, side string) (*shellFixture, string) {
	t.Helper()
	f := sidebarShell(t)
	card := f.tabbedCards()[0]
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": side, "set": "set-install"})
	return f, card
}

// storedSides returns the stored sidebars of the card.
func (f *shellFixture) storedSides(card string) map[string]any {
	f.t.Helper()
	for _, stored := range f.cardsOf() {
		if stored["id"] == card {
			data, _ := stored["data"].(map[string]any) // silent: a card without data stores no side.
			sides, _ := data["sidebars"].(map[string]any)
			return sides
		}
	}
	f.t.Fatalf("no card %s is stored", card)
	return nil
}

// cardBorder is the chrome metric bw: the width that the border of a card takes from each of its edges.
const cardBorder = 1

func TestACardShowsItsSetBesideItsContent(t *testing.T) {
	f, card := cardSidebar(t, "left")
	item := card + ":left"
	if status := element(t, f.tester, "core.card.sidebar.status", item); status.Label != "왼쪽 사이드바 · 탐색기" {
		t.Fatalf("the status line says %q", status.Label)
	}
	if name := element(t, f.tester, "core.sidebar.section.name", item+"/fieldprobe.tree"); name.Label != "파일 트리" {
		t.Fatalf("the name of the section is %q", name.Label)
	}
	box := f.box("core.card", card)
	side := f.box("core.sidebar", item)
	// The 190-point column reserves its inner border (1) and native-input
	// grip (6) outside the set, as .card-sidebar > .set does on the page.
	const columnWidth = 190
	const setWidth = columnWidth - cardBorder - 6
	if side.X != box.X+cardBorder || side.W != setWidth {
		t.Fatalf("the sidebar set stands at %+v in the card %+v, want width %v excluding border and grip", side, box, setWidth)
	}
	// The page names the set core.sidebar, and the status line of the sidebar stands below it in the same column (plane.js draws
	// `.set` and `.card-sidebar__status` in `.card-sidebar`): the column runs from below the header to the end of the footer.
	head := f.box("core.card.header", card)
	status := f.box("core.card.status", card)
	line := f.box("core.card.sidebar.status", item)
	if side.Y != head.Y+head.H || line.Y != side.Y+side.H || line.Y+line.H != status.Y+status.H {
		t.Fatalf("the sidebar %+v and its status line %+v do not run from below the header %+v to the end of the footer %+v", side, line, head, status)
	}
	if line.W != columnWidth {
		t.Fatalf("status line width %v must preserve full sidebar column width %v", line.W, columnWidth)
	}
	if status.X != box.X+cardBorder+columnWidth || status.W != box.W-2*cardBorder-columnWidth {
		t.Fatalf("the footer %+v does not span the content column of the card %+v", status, box)
	}
	f.audit()
}

// The rect of a sidebar in core.sidebars is the rect of its set, as the page reports the box of `.set`: a card side stops before its
// inner border and grip, and no sidebar holds its status line (docs/spec/example-model.md).
func TestTheStatusOfASidebarNamesTheRectOfItsSet(t *testing.T) {
	f, card := cardSidebar(t, "left")
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": "right", "set": "set-install"})
	var sidebars []struct {
		Sidebar string `json:"sidebar"`
		Rect    struct{ X, Y, W, H float32 }
	}
	if err := json.Unmarshal([]byte(f.status("core.sidebars")), &sidebars); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, drawn := range sidebars {
		set := f.box("core.sidebar", drawn.Sidebar)
		if got := (ui.Rect{X: drawn.Rect.X, Y: drawn.Rect.Y, W: drawn.Rect.W, H: drawn.Rect.H}); got != set {
			t.Errorf("core.sidebars names %s at %+v, and its set stands at %+v", drawn.Sidebar, got, set)
		}
		seen[drawn.Sidebar] = true
	}
	for _, want := range []string{"left", card + ":left", card + ":right"} {
		if !seen[want] {
			t.Errorf("core.sidebars has no %s: %+v", want, sidebars)
		}
	}
}

func TestATopSideLiesInTheContentColumn(t *testing.T) {
	f, card := cardSidebar(t, "top")
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": "left", "set": "set-install"})
	// The set of the left side stops before its border and grip; its status line spans the whole column.
	left, top := f.box("core.card.sidebar.status", card+":left"), f.box("core.sidebar", card+":top")
	if top.X != left.X+left.W {
		t.Fatalf("the top side %+v does not start after the column of the left side %+v", top, left)
	}
	// The top side is 190 tall: its set, the inner border and grip (7) below the set, and the status line.
	if line := f.box("core.card.sidebar.status", card+":top"); line.Y != top.Y+top.H+cardBorder+6 || line.Y+line.H-top.Y != 190 {
		t.Fatalf("the top side is %+v and its status line %+v", top, line)
	}
	value, err := f.shell.Registry().Read("core.sidebars")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"sidebar":"` + card + `:top"`, `"orientation":"horizontal"`, `"placement":"card"`, `"card":"` + card + `"`} {
		if !strings.Contains(string(encoded), want) {
			t.Errorf("the status has no %s: %s", want, encoded)
		}
	}
}

// The tool menu of a narrow head lists a sidebar item for each side that the card shows, in the order top, bottom, left, right and
// before the tools, as the page lists the sidebar buttons of the head; a pick folds the side, and the fullscreen item covers the plane.
func TestTheToolMenuHoldsTheSidesAndTheFullScreen(t *testing.T) {
	f, card := cardSidebar(t, "left")
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": "top", "set": "set-install"})
	f.tester.SetSize(480, 700)
	f.settle()
	f.click("core.card.tools", card)
	menu := f.menu()
	keys := menu.keys()
	if len(keys) < 3 || !slices.Equal(keys[:2], []string{"side-top", "side-left"}) || !slices.Contains(keys, "fullscreen") {
		t.Fatalf("the tool menu is %v", keys)
	}
	// The narrow card has no room for the left side, so the side is folded for lack of room, and its item unfolds it.
	if top, left := menu.Items[0], menu.Items[1]; top.Name != "위 사이드바 접기" || !top.Active || left.Name != "왼쪽 사이드바 펼치기" || left.Active {
		t.Fatalf("the items of the sides are %+v and %+v", top, left)
	}
	f.click("core.picker.item", "side-top")
	if sides := f.storedSides(card); sides["top"].(map[string]any)["collapsed"] != true {
		t.Fatalf("the pick of the top side stored %v", sides)
	}
	f.click("core.card.tools", card)
	f.click("core.picker.item", "fullscreen")
	value, err := f.shell.Registry().Read("core.grid")
	if err != nil {
		t.Fatal(err)
	}
	if encoded, _ := json.Marshal(value); !strings.Contains(string(encoded), `"fullscreen":"`+card+`"`) {
		t.Fatalf("the fullscreen item left the grid %s", encoded)
	}
}

func TestAFoldedSideOpensAgainFromTheHeader(t *testing.T) {
	f, card := cardSidebar(t, "left")
	item := card + ":left"
	f.run("core.card.sidebar.toggle", map[string]string{"card": card, "side": "left"})
	if f.has("core.card.sidebar.status", item) || f.has("core.sidebar", item) {
		t.Fatal("a folded side shows its set and its status line")
	}
	if sides := f.storedSides(card); sides["left"].(map[string]any)["collapsed"] != true {
		t.Fatalf("the stored sides are %v", sides)
	}
	status := f.box("core.card.status", card)
	box := f.box("core.card", card)
	if status.X != box.X+cardBorder+6 {
		t.Fatalf("the folded side takes more than the divider: %+v in %+v", status, box)
	}
	fold := f.box("core.card.sidebar.fold", item)
	f.tester.ClickAt(fold.X+fold.W/2, fold.Y+fold.H/2)
	f.settle()
	if !f.has("core.card.sidebar.status", item) {
		t.Fatal("the header control did not open the side")
	}
	f.audit()
}

func TestTheSizeOfASideIsStoredWithinItsBounds(t *testing.T) {
	f, card := cardSidebar(t, "right")
	f.run("core.card.sidebar.size", map[string]any{"card": card, "side": "right", "size": 240})
	// The size is the width of the column, which the status line spans.
	if line := f.box("core.card.sidebar.status", card+":right"); line.W != 240 {
		t.Fatalf("the column of the side is %+v", line)
	}
	if sides := f.storedSides(card); sides["right"].(map[string]any)["size"] != float64(240) {
		t.Fatalf("the stored sides are %v", sides)
	}
	_, err := f.answer("core.card.sidebar.size", map[string]any{"card": card, "side": "right", "size": 20})
	if err == nil || err.Error() != "sidebar size must be 120 to 480 points" {
		t.Fatalf("a size below the bound answers %v", err)
	}
}

func TestOffAndInheritChooseTheSet(t *testing.T) {
	f, card := cardSidebar(t, "left")
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": "left", "set": "off"})
	if f.has("core.sidebar", card+":left") || f.has("core.card.sidebar.fold", card+":left") {
		t.Fatal("a side that is off is drawn")
	}
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": "left", "set": "inherit"})
	if f.has("core.sidebar", card+":left") {
		t.Fatal("a side without a link of its plugin is drawn")
	}
	if _, err := f.answer("core.card.sidebar.set", map[string]string{"card": card, "side": "left", "set": "gone"}); err == nil {
		t.Fatal("an unknown set is taken")
	}
}

func TestACommandRefusesAFixedSidebarAndAMissingSide(t *testing.T) {
	f := sidebarShell(t)
	card := f.tabbedCards()[0]
	if _, err := f.answer("core.card.sidebar.toggle", map[string]string{"card": "left", "side": "left"}); err == nil {
		t.Fatal("a window sidebar took a card sidebar command")
	}
	_, err := f.answer("core.card.sidebar.toggle", map[string]string{"card": card, "side": "left"})
	if want := "card " + card + " has no left sidebar"; err == nil || err.Error() != want {
		t.Fatalf("a side that is not shown answers %v", err)
	}
}

func TestTheGripSizesTheSideAndAPressFoldsIt(t *testing.T) {
	f, card := cardSidebar(t, "left")
	item := card + ":left"
	grip := f.box("core.card.sidebar.grip", item)
	x, y := grip.X+grip.W/2, grip.Y+grip.H/2
	f.tester.Press(x, y)
	f.tester.Frame()
	f.tester.Move(x+30, y)
	f.tester.Frame()
	f.tester.Release(x+30, y)
	f.settle()
	if line := f.box("core.card.sidebar.status", item); line.W != 220 {
		t.Fatalf("after the drag the column of the side is %+v", line)
	}
	grip = f.box("core.card.sidebar.grip", item)
	x = grip.X + grip.W/2
	f.tester.ClickAt(x, y)
	f.settle()
	if f.has("core.sidebar", item) {
		t.Fatal("a press on the grip did not fold the side")
	}
}

// The grips of a card stand in the order of the sides of the page, top, bottom, left and right (SIDEBAR_SIDES of
// packages/workbench/plane.js), so the index of a grip names the same side on each host, and a drag of each grip by 10 points
// sizes its side by the displacement of the pointer (packages/workbench/sidebar-grip.js).
func TestTheGripsOfACardStandInTheOrderOfTheSides(t *testing.T) {
	f := sidebarShell(t)
	f.tester.SetSize(1200, 760)
	card := f.tabbedCards()[0]
	f.run("core.card.fullscreen", map[string]string{"card": card})
	sides := []string{"top", "bottom", "left", "right"}
	for _, side := range sides {
		f.run("core.card.sidebar.set", map[string]string{"card": card, "side": side, "set": "set-install"})
		f.run("core.card.sidebar.size", map[string]any{"card": card, "side": side, "size": 120})
	}
	f.settle()
	var order []string
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == "core.card.sidebar.grip" {
				order = append(order, exposed.Item)
			}
			walk(node.Children)
		}
	}
	walk(f.tester.ElementTree())
	want := []string{card + ":top", card + ":bottom", card + ":left", card + ":right"}
	if !slices.Equal(order, want) {
		t.Fatalf("the grips stand in the order %v, want %v", order, want)
	}
	moves := map[string][2]float32{"top": {0, 10}, "bottom": {0, -10}, "left": {10, 0}, "right": {-10, 0}}
	for _, side := range sides {
		grip := f.box("core.card.sidebar.grip", card+":"+side)
		x, y := grip.X+grip.W/2, grip.Y+grip.H/2
		dx, dy := moves[side][0], moves[side][1]
		f.tester.Press(x, y)
		f.tester.Frame()
		f.tester.Move(x+dx, y+dy)
		f.tester.Frame()
		f.tester.Release(x+dx, y+dy)
		f.settle()
		if size := f.storedSides(card)[side].(map[string]any)["size"]; size != float64(130) {
			t.Fatalf("a drag of the %s grip by 10 points stored the size %v, want 130", side, size)
		}
	}
}

func TestANarrowCardFoldsASideAndSaysSo(t *testing.T) {
	f, card := cardSidebar(t, "left")
	f.tester.SetSize(420, 400)
	f.settle()
	if f.has("core.sidebar", card+":left") {
		t.Fatalf("the side stands in a card of %+v", f.box("core.card", card))
	}
	if !f.tester.HasText("왼쪽 사이드바: 공간 부족으로 접힘") {
		t.Fatalf("the status line shows %q", f.tester.Texts())
	}
}

// sectionSurface returns the last placement of the section surface whose id ends in tail.
func sectionSurface(t *testing.T, stored *surfaceHost, tail string) map[string]any {
	t.Helper()
	for id, surface := range stored.lastSurfaces(t) {
		if strings.HasSuffix(id, tail) {
			return surface
		}
	}
	return nil
}

func TestASectionStandsInItsSurface(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	surface := sectionSurface(t, stored, "/left/fieldprobe.tree")
	if surface == nil || surface["visible"] != true || surface["plugin"] != "fieldprobe" {
		t.Fatalf("the section surface is %v", surface)
	}
	start := surface["start"].(map[string]any)["section"].(map[string]any)
	if start["id"] != "fieldprobe.tree" || start["sidebar"] != "left" || start["card"] != nil {
		t.Fatalf("the start value of the section is %v", start)
	}
	if page := surface["composition"].(map[string]any)["page"]; page != "ui/tree.html" {
		t.Fatalf("the composition of the section is %v", surface["composition"])
	}
	body := f.box("core.card", "left")
	if surface["x"] != float64(body.X+cardBorder) || surface["w"] != float64(body.W-2*cardBorder) || surface["y"].(float64) <= float64(body.Y) {
		t.Fatalf("the surface stands at %v in the sidebar %+v", surface, body)
	}
}

// sectionState is a section of core.sidebars.
type sectionState struct {
	ID        string  `json:"id"`
	SurfaceID string  `json:"surfaceId"`
	Folded    bool    `json:"folded"`
	Mounted   bool    `json:"mounted"`
	Phase     *string `json:"phase"`
	Error     *string `json:"error"`
}

// sectionOf returns the section of the sidebar in core.sidebars.
func (f *shellFixture) sectionOf(sidebar, section string) sectionState {
	f.t.Helper()
	var sidebars []struct {
		Sidebar  string         `json:"sidebar"`
		Sections []sectionState `json:"sections"`
	}
	if err := json.Unmarshal([]byte(f.status("core.sidebars")), &sidebars); err != nil {
		f.t.Fatal(err)
	}
	for _, drawn := range sidebars {
		if drawn.Sidebar != sidebar {
			continue
		}
		for _, state := range drawn.Sections {
			if state.ID == section {
				return state
			}
		}
	}
	f.t.Fatalf("core.sidebars has no section %s of %s: %+v", section, sidebar, sidebars)
	return sectionState{}
}

// Closing a surface ends its in-flight calls (docs/spec/native-surfaces.md): a section that the space left has no view to answer.
func TestACallOfASectionThatTheSpaceLeftIsDropped(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	left := f.sectionOf("left", "fieldprobe.bookmarks").SurfaceID
	f.run("core.space.add", nil)
	f.settle()
	if _, held := stored.lastSurfaces(t)[left]; held {
		t.Fatalf("the space left the section %s, and the host still holds it", left)
	}
	before := len(stored.replies)
	f.shell.Event("view-call", []any{map[string]any{"surface": left, "plugin": "fieldprobe", "generation": 1, "id": 7, "command": "runtime.data.get", "params": map[string]string{"key": "marks"}}})
	f.settle()
	if len(stored.replies) != before {
		t.Fatalf("the ended section got the reply %v", stored.replies[len(stored.replies)-1])
	}
	f.shell.Event("view-call", []any{map[string]any{"surface": left, "plugin": "fieldprobe", "generation": 1, "id": 8, "command": "runtime.error", "params": map[string]string{"where": "fieldprobe bookmarks", "text": "late"}}})
	f.settle()
	if len(stored.replies) != before {
		t.Fatalf("the ended section got the reply %v", stored.replies[len(stored.replies)-1])
	}
	if slices.ContainsFunc(f.lines, func(line string) bool { return strings.Contains(line, "late") }) {
		t.Fatalf("the ended section reported an error: %v", f.lines)
	}
}

func TestASectionIsMountedOnceItsViewAnswers(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	loading := f.sectionOf("left", "fieldprobe.tree")
	if loading.Mounted || loading.Phase == nil || *loading.Phase != "loading" {
		t.Fatalf("a section whose view did not answer is %+v", loading)
	}
	viewCall(t, f, stored, loading.SurfaceID, "runtime.settings.read", nil)
	ready := f.sectionOf("left", "fieldprobe.tree")
	if !ready.Mounted || ready.Phase == nil || *ready.Phase != "ready" || ready.Error != nil {
		t.Fatalf("a section whose view answered is %+v", ready)
	}
	// A folded section keeps its surface, as a hidden tab does.
	f.run("core.sidebar.section.fold", map[string]string{"sidebar": "left", "section": "fieldprobe.tree"})
	if folded := f.sectionOf("left", "fieldprobe.tree"); !folded.Folded || !folded.Mounted || *folded.Phase != "ready" {
		t.Fatalf("a folded section is %+v", folded)
	}
}

func TestASectionShowsThatItsViewStopped(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	id := f.sectionOf("left", "fieldprobe.tree").SurfaceID
	viewCall(t, f, stored, id, "runtime.settings.read", nil)
	f.shell.Event("view-stopped", []any{map[string]any{"surface": id, "reason": "the view stopped"}})
	f.settle()
	stopped := f.sectionOf("left", "fieldprobe.tree")
	if stopped.Mounted || stopped.Phase == nil || *stopped.Phase != "error" || stopped.Error == nil || *stopped.Error != "the view stopped" {
		t.Fatalf("a section whose view stopped is %+v", stopped)
	}
}

// The status of a surface in core.surfaces is `{phase, error}` (docs/spec/exposure.md): the error is null while the view lives and
// names the reason once it stopped.
func TestTheSurfaceStatusNamesTheErrorOfAStoppedView(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	id := f.sectionOf("left", "fieldprobe.tree").SurfaceID
	viewCall(t, f, stored, id, "runtime.settings.read", nil)
	statusOf := func() map[string]any {
		t.Helper()
		for _, row := range status[[]map[string]any](t, f, "core.surfaces") {
			if row["surface"] == id {
				return row["status"].(map[string]any)
			}
		}
		t.Fatalf("core.surfaces has no surface %s", id)
		return nil
	}
	if got := statusOf(); !reflect.DeepEqual(got, map[string]any{"phase": "ready", "error": nil}) {
		t.Fatalf("the status of a live view is %v", got)
	}
	f.shell.Event("view-stopped", []any{map[string]any{"surface": id, "reason": "the view stopped"}})
	f.settle()
	if got := statusOf(); !reflect.DeepEqual(got, map[string]any{"phase": "error", "error": "the view stopped"}) {
		t.Fatalf("the status of a stopped view is %v", got)
	}
}

// Every section of a set has its surface from the start, and a section of an unselected tab keeps it hidden.
func TestASectionOfAnUnselectedTabHasItsSurfaceHidden(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	card := f.tabbedCards()[0]
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": "left", "set": "set-boxprobe"})
	tail := "/" + card + ":left/boxprobe.history"
	surface := sectionSurface(t, stored, tail)
	if surface == nil || surface["visible"] != false {
		t.Fatalf("the section of the unselected tab has the surface %v", surface)
	}
	f.run("core.sidebar.section.select", map[string]string{"sidebar": card + ":left", "section": "boxprobe.history"})
	surface = sectionSurface(t, stored, tail)
	if surface == nil || surface["visible"] != true || surface["w"].(float64) <= 0 || surface["h"].(float64) <= 0 {
		t.Fatalf("the section of the selected tab has the surface %v", surface)
	}
}

func TestAFoldedSectionKeepsItsSurfaceHidden(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	f.run("core.sidebar.section.fold", map[string]string{"sidebar": "left", "section": "fieldprobe.tree"})
	if surface := sectionSurface(t, stored, "/left/fieldprobe.tree"); surface == nil || surface["visible"] != false {
		t.Fatalf("the folded section has the surface %v", surface)
	}
	f.run("core.sidebar.section.fold", map[string]string{"sidebar": "left", "section": "fieldprobe.tree"})
	if surface := sectionSurface(t, stored, "/left/fieldprobe.tree"); surface == nil || surface["visible"] != true {
		t.Fatalf("the open section has the surface %v", surface)
	}
}

func TestACardSectionFollowsItsCardAndEndsWithItsSide(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	card := f.tabbedCards()[0]
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": "left", "set": "set-install"})
	tail := "/" + card + ":left/fieldprobe.tree"
	surface := sectionSurface(t, stored, tail)
	if surface == nil || surface["visible"] != true {
		t.Fatalf("the section of the card has the surface %v", surface)
	}
	if start := surface["start"].(map[string]any)["section"].(map[string]any); start["card"] != card {
		t.Fatalf("the start value of the section is %v", start)
	}
	if side := f.box("core.sidebar", card+":left"); surface["x"] != float64(side.X) {
		t.Fatalf("the surface stands at %v in the side %+v", surface, side)
	}
	f.run("core.card.sidebar.toggle", map[string]string{"card": card, "side": "left"})
	if surface := sectionSurface(t, stored, tail); surface == nil || surface["visible"] != false {
		t.Fatalf("a folded side has the surface %v", surface)
	}
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": "left", "set": "off"})
	if surface := sectionSurface(t, stored, tail); surface != nil {
		t.Fatalf("a side that is off holds the surface %v", surface)
	}
}

// A window takes the sets and the links of the settings at once, and they start as the declared ones.
func TestTheSettingsHoldTheSetsAndLinksOfTheSidebars(t *testing.T) {
	f := sidebarShell(t)
	f.run("core.settings.link", map[string]any{"place": "left", "plugin": nil, "set": "set-boxprobe"})
	if status := element(t, f.tester, "core.sidebar.status", "left"); status.Label != "왼쪽 창 사이드바" {
		t.Fatalf("the status line says %q", status.Label)
	}
	element(t, f.tester, "core.sidebar.tabs", "left")
	if f.has("core.sidebar.section.name", "left/fieldprobe.tree") {
		t.Fatal("the left sidebar keeps the set of the environment")
	}
	f.run("core.settings.sets.create", nil)
	var status struct {
		Values struct {
			Sets []struct {
				ID string `json:"id"`
			} `json:"sets"`
		} `json:"values"`
	}
	if err := json.Unmarshal([]byte(f.status("core.settings")), &status); err != nil {
		t.Fatal(err)
	}
	if len(status.Values.Sets) != 4 || status.Values.Sets[3].ID != "set-1" {
		t.Fatalf("the settings hold the sets %v", status.Values.Sets)
	}
}
