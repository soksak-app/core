// 표면 동기화가 창 덮개를 놓고 배치를 시작하는 순서와, 실패할 때 시작한 배치를 남기지 않는지 검사한다.
package host_test

import (
	"errors"
	"reflect"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: surfaces.sync.failure-leaves-no-begun-layout
func TestRefusedWindowOverlayLeavesNoBegunLayout(t *testing.T) {
	var calls []string
	err := host.RunLayout(func() error {
		calls = append(calls, "overlays")
		return errors.New("overlay refused")
	}, func() error {
		calls = append(calls, "begin")
		return nil
	})
	if err == nil || err.Error() != "overlay refused" || !reflect.DeepEqual(calls, []string{"overlays"}) {
		t.Fatalf("RunLayout = %v, calls %v", err, calls)
	}
}

// contract: surfaces.sync.failure-leaves-no-begun-layout
func TestFailedSurfaceStepCancelsBegunLayout(t *testing.T) {
	var calls []string
	err := host.ApplyOrCancel(func() error {
		calls = append(calls, "steps")
		return errors.New("surface failed")
	}, func() error {
		calls = append(calls, "cancel")
		return nil
	})
	if err == nil || err.Error() != "surface failed" || !reflect.DeepEqual(calls, []string{"steps", "cancel"}) {
		t.Fatalf("ApplyOrCancel = %v, calls %v", err, calls)
	}
	if err := host.ApplyOrCancel(func() error { return nil }, func() error {
		t.Fatal("a successful step cancelled the layout")
		return nil
	}); err != nil {
		t.Fatalf("ApplyOrCancel = %v", err)
	}
}
