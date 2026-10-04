// 창 객체 수 응답 테스트. 수는 공용 라이브러리가 세며 여기서는 응답의 이름과 값만 검사한다.
package host_test

import (
	"reflect"
	"testing"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// contract: diagnostics.native-objects.payload-names-counts
func TestWindowObjectsPayloadNamesTheCounts(t *testing.T) {
	payload := platform.WindowObjects{WindowCompositions: 1, SurfaceHosts: 2, InputRegistrations: 3}.Payload()
	want := map[string]int64{"windowCompositions": 1, "surfaceHosts": 2, "inputRegistrations": 3}
	if !reflect.DeepEqual(payload, want) {
		t.Fatalf("payload = %#v, want %#v", payload, want)
	}
}

// contract: diagnostics.native-objects.equal-validates
func TestWindowObjectsEqualValidates(t *testing.T) {
	equal, err := platform.ParseWindowObjects([]byte(`{"windowCompositions":1,"surfaceHosts":2,"inputRegistrations":0}`))
	want := platform.WindowObjects{WindowCompositions: 1, SurfaceHosts: 2}
	if err != nil || equal != want {
		t.Fatalf("ParseWindowObjects = %#v, %v, want %#v", equal, err, want)
	}
	for _, raw := range []string{
		`null`, `[]`, `1`, `{}`,
		`{"windowCompositions":1,"surfaceHosts":2}`,
		`{"windowCompositions":1,"surfaceHosts":2,"inputRegistrations":-1}`,
		`{"windowCompositions":1.5,"surfaceHosts":2,"inputRegistrations":0}`,
		`{"windowCompositions":"1","surfaceHosts":2,"inputRegistrations":0}`,
		`{"windowCompositions":1,"surfaceHosts":2,"inputRegistrations":0,"other":0}`,
		`{"windowCompositions":1,"surfaceHosts":2,"other":0}`,
	} {
		if _, err := platform.ParseWindowObjects([]byte(raw)); err == nil ||
			err.Error() != "equal must be an object of windowCompositions, surfaceHosts and inputRegistrations, each a non-negative integer" {
			t.Errorf("ParseWindowObjects(%s) error = %v", raw, err)
		}
	}
	counts := platform.WindowObjects{WindowCompositions: 2, SurfaceHosts: 2, InputRegistrations: 1}.String()
	if counts != "windowCompositions 2, surfaceHosts 2, inputRegistrations 1" {
		t.Fatalf("String = %q", counts)
	}
}

// contract: diagnostics.process-exit.pid-validates
func TestProcessExitPidValidates(t *testing.T) {
	if pid, err := platform.ParseProcessID([]byte(`2147483647`)); err != nil || pid != 2147483647 {
		t.Fatalf("ParseProcessID(2147483647) = %d, %v", pid, err)
	}
	for _, raw := range []string{``, `null`, `0`, `-1`, `1.5`, `"12"`, `2147483648`, `{}`} {
		if _, err := platform.ParseProcessID([]byte(raw)); err == nil || err.Error() != "pid must be a positive integer" {
			t.Errorf("ParseProcessID(%q) error = %v", raw, err)
		}
	}
}
