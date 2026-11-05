// The sidebars of a card: the choice of each side, its place around the content, its grip and its header control
// (docs/spec/example-model.md).
package workbench_test

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
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
	if name := element(t, f.tester, "core.sidebar.section.name", item+"/files.tree"); name.Label != "파일 트리" {
		t.Fatalf("the name of the section is %q", name.Label)
	}
	box := f.box("core.card", card)
	side := f.box("core.sidebar", item)
	if side.X != box.X+cardBorder || side.W != 190 {
		t.Fatalf("the sidebar stands at %+v in the card %+v", side, box)
	}
	head := f.box("core.card.header", card)
	status := f.box("core.card.status", card)
	if side.Y != head.Y+head.H || side.Y+side.H != status.Y+status.H {
		t.Fatalf("the sidebar %+v does not run from below the header %+v to the end of the footer %+v", side, head, status)
	}
	if status.X != box.X+cardBorder+side.W || status.W != box.W-2*cardBorder-side.W {
		t.Fatalf("the footer %+v does not span the content column of the card %+v", status, box)
	}
	f.audit()
}

func TestATopSideLiesInTheContentColumn(t *testing.T) {
	f, card := cardSidebar(t, "top")
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": "left", "set": "set-install"})
	left, top := f.box("core.sidebar", card+":left"), f.box("core.sidebar", card+":top")
	if top.X != left.X+left.W {
		t.Fatalf("the top side %+v does not start after the left side %+v", top, left)
	}
	if top.H != 190 {
		t.Fatalf("the top side is %+v", top)
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
	if side := f.box("core.sidebar", card+":right"); side.W != 240 {
		t.Fatalf("the side is %+v", side)
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
	if side := f.box("core.sidebar", item); side.W != 220 {
		t.Fatalf("after the drag the side is %+v", side)
	}
	grip = f.box("core.card.sidebar.grip", item)
	x = grip.X + grip.W/2
	f.tester.ClickAt(x, y)
	f.settle()
	if f.has("core.sidebar", item) {
		t.Fatal("a press on the grip did not fold the side")
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
	surface := sectionSurface(t, stored, "/left/files.tree")
	if surface == nil || surface["visible"] != true || surface["plugin"] != "files" {
		t.Fatalf("the section surface is %v", surface)
	}
	start := surface["start"].(map[string]any)["section"].(map[string]any)
	if start["id"] != "files.tree" || start["sidebar"] != "left" || start["card"] != nil {
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
	left := f.sectionOf("left", "files.bookmarks").SurfaceID
	f.run("core.space.add", nil)
	f.settle()
	if _, held := stored.lastSurfaces(t)[left]; held {
		t.Fatalf("the space left the section %s, and the host still holds it", left)
	}
	before := len(stored.replies)
	f.shell.Event("view-call", []any{map[string]any{"surface": left, "plugin": "files", "generation": 1, "id": 7, "command": "runtime.data.get", "params": map[string]string{"key": "marks"}}})
	f.settle()
	if len(stored.replies) != before {
		t.Fatalf("the ended section got the reply %v", stored.replies[len(stored.replies)-1])
	}
	f.shell.Event("view-call", []any{map[string]any{"surface": left, "plugin": "files", "generation": 1, "id": 8, "command": "runtime.error", "params": map[string]string{"where": "files bookmarks", "text": "late"}}})
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
	loading := f.sectionOf("left", "files.tree")
	if loading.Mounted || loading.Phase == nil || *loading.Phase != "loading" {
		t.Fatalf("a section whose view did not answer is %+v", loading)
	}
	viewCall(t, f, stored, loading.SurfaceID, "runtime.settings.read", nil)
	ready := f.sectionOf("left", "files.tree")
	if !ready.Mounted || ready.Phase == nil || *ready.Phase != "ready" || ready.Error != nil {
		t.Fatalf("a section whose view answered is %+v", ready)
	}
	// A folded section keeps its surface, as a hidden tab does.
	f.run("core.sidebar.section.fold", map[string]string{"sidebar": "left", "section": "files.tree"})
	if folded := f.sectionOf("left", "files.tree"); !folded.Folded || !folded.Mounted || *folded.Phase != "ready" {
		t.Fatalf("a folded section is %+v", folded)
	}
}

func TestASectionShowsThatItsViewStopped(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	id := f.sectionOf("left", "files.tree").SurfaceID
	viewCall(t, f, stored, id, "runtime.settings.read", nil)
	f.shell.Event("view-stopped", []any{map[string]any{"surface": id, "reason": "the view stopped"}})
	f.settle()
	stopped := f.sectionOf("left", "files.tree")
	if stopped.Mounted || stopped.Phase == nil || *stopped.Phase != "error" || stopped.Error == nil || *stopped.Error != "the view stopped" {
		t.Fatalf("a section whose view stopped is %+v", stopped)
	}
}

// Every section of a set has its surface from the start, and a section of an unselected tab keeps it hidden.
func TestASectionOfAnUnselectedTabHasItsSurfaceHidden(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	card := f.tabbedCards()[0]
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": "left", "set": "set-browser"})
	tail := "/" + card + ":left/browser.history"
	surface := sectionSurface(t, stored, tail)
	if surface == nil || surface["visible"] != false {
		t.Fatalf("the section of the unselected tab has the surface %v", surface)
	}
	f.run("core.sidebar.section.select", map[string]string{"sidebar": card + ":left", "section": "browser.history"})
	surface = sectionSurface(t, stored, tail)
	if surface == nil || surface["visible"] != true || surface["w"].(float64) <= 0 || surface["h"].(float64) <= 0 {
		t.Fatalf("the section of the selected tab has the surface %v", surface)
	}
}

func TestAFoldedSectionKeepsItsSurfaceHidden(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	f.run("core.sidebar.section.fold", map[string]string{"sidebar": "left", "section": "files.tree"})
	if surface := sectionSurface(t, stored, "/left/files.tree"); surface == nil || surface["visible"] != false {
		t.Fatalf("the folded section has the surface %v", surface)
	}
	f.run("core.sidebar.section.fold", map[string]string{"sidebar": "left", "section": "files.tree"})
	if surface := sectionSurface(t, stored, "/left/files.tree"); surface == nil || surface["visible"] != true {
		t.Fatalf("the open section has the surface %v", surface)
	}
}

func TestACardSectionFollowsItsCardAndEndsWithItsSide(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	card := f.tabbedCards()[0]
	f.run("core.card.sidebar.set", map[string]string{"card": card, "side": "left", "set": "set-install"})
	tail := "/" + card + ":left/files.tree"
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
	f.run("core.settings.link", map[string]any{"place": "left", "plugin": nil, "set": "set-browser"})
	if status := element(t, f.tester, "core.sidebar.status", "left"); status.Label != "왼쪽 창 사이드바" {
		t.Fatalf("the status line says %q", status.Label)
	}
	element(t, f.tester, "core.sidebar.tabs", "left")
	if f.has("core.sidebar.section.name", "left/files.tree") {
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
