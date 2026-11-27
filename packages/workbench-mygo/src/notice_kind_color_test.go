package workbench

import (
	"testing"
)

// The success and warning notice icons draw the ok and warn tokens of the palette, which the theme of the mode declares
// (docs/spec/notifications.md#notices).
func TestNoticeKindColorDrawsTheOkAndWarnTokens(t *testing.T) {
	declared, err := Declared()
	if err != nil {
		t.Fatal(err)
	}
	palette, err := declared.DefaultPalette()
	if err != nil {
		t.Fatal(err)
	}
	if palette.Ok == palette.Muted || palette.Warn == palette.Muted {
		t.Fatal("the ok and warn tokens of the theme are not distinct from the muted color")
	}
	shell := &Shell{palette: palette}
	if got, want := shell.noticeKindColor("success"), palette.Ok; got != want {
		t.Fatalf("the success icon color = %v, want the ok token %v", got, want)
	}
	if got, want := shell.noticeKindColor("warning"), palette.Warn; got != want {
		t.Fatalf("the warning icon color = %v, want the warn token %v", got, want)
	}
}
