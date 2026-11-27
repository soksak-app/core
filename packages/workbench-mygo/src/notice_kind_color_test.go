package workbench

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// The success and warning notice icons draw the ok and warn tokens of the mode, with the values that the design gives for the dark
// mode (docs/spec/notifications.md#notices).
func TestNoticeKindColorDrawsTheOkAndWarnTokens(t *testing.T) {
	declared, err := Declared()
	if err != nil {
		t.Fatal(err)
	}
	palette, err := declared.DefaultPalette()
	if err != nil {
		t.Fatal(err)
	}
	shell := &Shell{palette: palette}
	if got, want := shell.noticeKindColor("success"), ui.Hex("#4cc38a"); got != want {
		t.Fatalf("the success icon color = %v, want the ok token #4cc38a", got)
	}
	if got, want := shell.noticeKindColor("warning"), ui.Hex("#f0a33a"); got != want {
		t.Fatalf("the warning icon color = %v, want the warn token #f0a33a", got)
	}
}
