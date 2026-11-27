package workbench

import "testing"

// A notice kind draws the icon that its name declares, and a kind without a declared icon is an error, because the kinds are a closed set
// (docs/spec/notifications.md#notices).
func TestNoticeGlyphNameDrawsTheProgressRingAndRefusesAKindWithoutAnIcon(t *testing.T) {
	icons := map[string]string{"notice-info": "<path/>", "notice-progress": "<path/>"}
	name, err := noticeGlyphName("progress", icons)
	if err != nil || name != "notice-progress" {
		t.Fatalf("progress glyph = %q, %v; want notice-progress", name, err)
	}
	if _, err := noticeGlyphName("bogus", icons); err == nil {
		t.Fatal("a kind without a declared icon was accepted")
	}
}

// The progress ring turns only while the desktop allows motion, and no other kind turns (docs/spec/notifications.md#notices).
func TestNoticeTurnsOnlyTheProgressRingUnderAllowedMotion(t *testing.T) {
	if !noticeTurns("progress", false) {
		t.Fatal("the progress ring does not turn when motion is allowed")
	}
	if noticeTurns("progress", true) {
		t.Fatal("the progress ring turns under reduced motion")
	}
	for _, kind := range []string{"info", "success", "warning", "error"} {
		if noticeTurns(kind, false) {
			t.Fatalf("the %s icon turns", kind)
		}
	}
}
