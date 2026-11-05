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
