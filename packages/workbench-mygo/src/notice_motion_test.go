package workbench

import "testing"

// The override of the application decides the reduced motion of the notice ring when one is set, and the platform value applies when
// none is set (docs/spec/endpoint.md#diagnostic-builds).
func TestTheMotionOverrideDecidesTheTurnAndNullReadsThePlatformValue(t *testing.T) {
	yes, no := true, false
	if !effectiveReduceMotion(nil, true) || effectiveReduceMotion(nil, false) {
		t.Fatal("no override must read the platform value")
	}
	if !effectiveReduceMotion(&yes, false) {
		t.Fatal("an override of true must reduce motion when the platform allows it")
	}
	if effectiveReduceMotion(&no, true) {
		t.Fatal("an override of false must allow motion when the platform reduces it")
	}
	if noticeTurns("progress", effectiveReduceMotion(&yes, false)) {
		t.Fatal("a progress ring with an override of true must not turn")
	}
}
