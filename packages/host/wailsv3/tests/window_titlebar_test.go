// 표면 준비가 담는 창 제목줄 높이의 검사를 확인한다(docs/spec/native-surfaces.md#title-bar-height). 두 host 는
// 같은 값을 같은 문장으로, 배치 트랜잭션을 시작하기 전에 거부한다.
package host_test

import (
	"encoding/json"
	"math"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// titlebarRequest 는 페이지가 보내는 형태의 표면 동기화 요청이다. JSON 은 NaN 과 무한대를 담을 수 없다.
func titlebarRequest(t *testing.T, titlebar string) host.SyncRequest {
	t.Helper()
	var request host.SyncRequest
	if err := json.Unmarshal([]byte(`{"settled":true,"surfaces":[],"titlebar":`+titlebar+`}`), &request); err != nil {
		t.Fatalf("the sync request fixture is not JSON: %v", err)
	}
	return request
}

// contract: surfaces.sync.titlebar.accepts-heights-in-range
func TestSyncRequestAcceptsTitlebarHeightsInRange(t *testing.T) {
	for _, height := range []string{"32", "40", "54", "54.5", "108", "200"} {
		if _, err := host.CheckSyncRequest(titlebarRequest(t, height), map[string]host.SurfaceComposition{}); err != nil {
			t.Fatalf("a sync request with title bar %s was refused: %v", height, err)
		}
	}
}

// contract: surfaces.sync.titlebar.rejects-other-heights
func TestSyncRequestRejectsOtherTitlebarHeights(t *testing.T) {
	const want = "title bar height must be a finite number from 32 through 200 points"
	for _, height := range []string{"31.99", "0", "-1", "-40", "200.01", "1e300"} {
		_, err := host.CheckSyncRequest(titlebarRequest(t, height), map[string]host.SurfaceComposition{})
		if err == nil || err.Error() != want {
			t.Fatalf("the sync check returned %v for title bar %s before the layout began, want %q", err, height, want)
		}
	}
	for _, height := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if err := host.ValidateTitlebarHeight(height); err == nil || err.Error() != want {
			t.Fatalf("%v was rejected with %v, want %q", height, err, want)
		}
	}
}
