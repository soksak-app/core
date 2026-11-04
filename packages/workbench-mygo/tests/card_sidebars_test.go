// The sidebars of a card: the choice of each side, its place around the content, its grip and its header control
// (docs/spec/example-model.md).
package workbench_test

import (
	"encoding/json"
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
	if side.X != box.X || side.W != 190 {
		t.Fatalf("the sidebar stands at %+v in the card %+v", side, box)
	}
	head := f.box("core.card.header", card)
	status := f.box("core.card.status", card)
	if side.Y != head.Y+head.H || side.Y+side.H != status.Y+status.H {
		t.Fatalf("the sidebar %+v does not run from below the header %+v to the end of the footer %+v", side, head, status)
	}
	if status.X != box.X+side.W || status.W != box.W-side.W {
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
	if status.X != box.X+6 {
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
	if surface["x"] != float64(body.X) || surface["w"] != float64(body.W) || surface["y"].(float64) <= float64(body.Y) {
		t.Fatalf("the surface stands at %v in the sidebar %+v", surface, body)
	}
	value, err := f.shell.Registry().Read("core.sidebars")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"mounted":true`) {
		t.Fatalf("the status is %s", encoded)
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
