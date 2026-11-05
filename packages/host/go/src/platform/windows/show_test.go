package windows

import "testing"

func TestOnlyTheForegroundShowsWithActivation(t *testing.T) {
	if got := showCommand(true); got != swShow {
		t.Fatalf("command %d, want %d", got, swShow)
	}
	if got := showCommand(false); got != swShowNoActivate {
		t.Fatalf("command %d, want %d", got, swShowNoActivate)
	}
}
