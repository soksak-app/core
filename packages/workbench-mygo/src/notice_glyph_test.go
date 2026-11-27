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
