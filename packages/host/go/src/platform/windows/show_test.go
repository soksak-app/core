package windows

import "testing"

// contract: platform.windows.show.only-foreground-shows-with-activation
func TestOnlyTheForegroundShowsWithActivation(t *testing.T) {
	if got := showCommand(true); got != swShow {
		t.Fatalf("command %d, want %d", got, swShow)
	}
	if got := showCommand(false); got != swShowNoActivate {
		t.Fatalf("command %d, want %d", got, swShowNoActivate)
	}
}
