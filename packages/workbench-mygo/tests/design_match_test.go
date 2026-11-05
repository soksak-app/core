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
