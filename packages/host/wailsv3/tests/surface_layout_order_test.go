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
	err := host.ApplyOrCancel(func() (func() error, error) {
		calls = append(calls, "titlebar")
		return func() error {
			calls = append(calls, "restore")
			return nil
		}, nil
	}, func() error {
		calls = append(calls, "steps")
		return errors.New("surface failed")
	}, func() error {
		calls = append(calls, "cancel")
		return nil
	})
	if err == nil || err.Error() != "surface failed" || !reflect.DeepEqual(calls, []string{"titlebar", "steps", "restore", "cancel"}) {
		t.Fatalf("ApplyOrCancel = %v, calls %v", err, calls)
	}
	if err := host.ApplyOrCancel(func() (func() error, error) { return func() error { return nil }, nil }, func() error { return nil }, func() error {
		t.Fatal("a successful step cancelled the layout")
		return nil
	}); err != nil {
		t.Fatalf("ApplyOrCancel = %v", err)
	}
}

// contract: surfaces.sync.titlebar.set-in-begun-layout
func TestTitlebarIsSetInTheBegunLayoutBeforeTheSurfaces(t *testing.T) {
	var calls []string
	step := func(name string, err error) func() error {
		return func() error {
			calls = append(calls, name)
			return err
		}
	}
	titlebar := func(err, restoreErr error) func() (func() error, error) {
		return func() (func() error, error) {
			calls = append(calls, "titlebar")
			return step("restore", restoreErr), err
		}
	}
	if err := host.ApplyOrCancel(titlebar(nil, nil), step("surfaces", nil), step("cancel", nil)); err != nil {
		t.Fatalf("ApplyOrCancel = %v", err)
	}
	if want := []string{"titlebar", "surfaces"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls %v, want %v", calls, want)
	}
	calls = nil
	const refused = "the window has no standard buttons or content view for a title bar"
	err := host.ApplyOrCancel(titlebar(errors.New(refused), nil), step("surfaces", nil), step("cancel", nil))
	if err == nil || err.Error() != refused {
		t.Fatalf("ApplyOrCancel = %v, want %q", err, refused)
	}
	if want := []string{"titlebar", "cancel"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("a refused title bar made the calls %v, want %v", calls, want)
	}
	calls = nil
	err = host.ApplyOrCancel(titlebar(nil, nil), step("surfaces", errors.New("surface failed")), step("cancel", nil))
	if err == nil || err.Error() != "surface failed" {
		t.Fatalf("ApplyOrCancel = %v, want surface failed", err)
	}
	if want := []string{"titlebar", "surfaces", "restore", "cancel"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("a failed surface step made the calls %v, want %v", calls, want)
	}
	calls = nil
	err = host.ApplyOrCancel(titlebar(nil, errors.New("restore failed")), step("surfaces", errors.New("surface failed")), step("cancel", nil))
	if want := "surface failed; restoring the title bar: restore failed"; err == nil || err.Error() != want {
		t.Fatalf("ApplyOrCancel = %v, want %q", err, want)
	}
}
