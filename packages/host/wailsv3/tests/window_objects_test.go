// 창 객체 수 응답 테스트. 수는 공용 라이브러리가 세며 여기서는 응답의 이름과 값만 검사한다.
package host_test

import (
	"reflect"
	"testing"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

// contract: diagnostics.native-objects.payload-names-counts
func TestWindowObjectsPayloadNamesTheCounts(t *testing.T) {
	payload := platform.WindowObjects{WindowCompositions: 1, SurfaceHosts: 2, InputRegistrations: 3}.Payload()
	want := map[string]int64{"windowCompositions": 1, "surfaceHosts": 2, "inputRegistrations": 3}
	if !reflect.DeepEqual(payload, want) {
		t.Fatalf("payload = %#v, want %#v", payload, want)
	}
}
