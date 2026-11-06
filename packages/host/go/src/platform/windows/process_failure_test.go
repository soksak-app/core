package windows

import "testing"

// contract: platform.windows.page-process.failure-kind-decides-the-page
func TestTheEndOfThePageProcessEndsThePage(t *testing.T) {
	for _, kind := range []int32{0, 1} {
		if got := processFailureOf(kind); got != pageEnded {
			t.Fatalf("kind %d: %v, want the end of the page", kind, got)
		}
	}
}

// contract: platform.windows.page-process.failure-kind-decides-the-page
func TestEveryOtherKindKeepsThePage(t *testing.T) {
	for kind := int32(2); kind <= 9; kind++ {
		if got := processFailureOf(kind); got != pageStays {
			t.Fatalf("kind %d: %v, want the page to stay", kind, got)
		}
	}
}
