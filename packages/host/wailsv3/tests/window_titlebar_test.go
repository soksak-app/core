// 페이지가 요청하는 창 제목줄 높이의 검사를 확인한다(docs/spec/hosts.md#window-buttons). 두 host 는 같은 값을
// 같은 문장으로 거부한다.
package host_test

import (
	"math"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: window.titlebar.accepts-heights-in-range
func TestWindowTitlebarAcceptsHeightsInRange(t *testing.T) {
	for _, height := range []float64{32, 40, 54, 54.5, 108, 200} {
		if err := host.ValidateTitlebarHeight(height); err != nil {
			t.Fatalf("%v was rejected: %v", height, err)
		}
	}
}

// contract: window.titlebar.rejects-other-heights
func TestWindowTitlebarRejectsOtherHeights(t *testing.T) {
	const want = "title bar height must be a finite number from 32 through 200 points"
	for _, height := range []float64{31.99, 0, -1, -40, 200.01, 1e300, math.NaN(), math.Inf(1), math.Inf(-1)} {
		err := host.ValidateTitlebarHeight(height)
		if err == nil {
			t.Fatalf("%v was accepted", height)
		}
		if err.Error() != want {
			t.Fatalf("%v was rejected with %q, want %q", height, err.Error(), want)
		}
	}
}
