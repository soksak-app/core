package host_test

import (
	"errors"
	"strings"
	"testing"
	"unsafe"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

// contract: surface-activation.owner.resolves-registered-view, surface-activation.owner.ignores-unknown-view, surface-activation.owner.ignores-empty-owner
func TestSurfaceOwnerIDOnlyResolvesRegisteredNativeViews(t *testing.T) {
	named := map[uintptr]string{101: "tab-1", 202: "tab-2"}
	if id, ok := host.SurfaceOwnerID(named, 101); !ok || id != "tab-1" {
		t.Fatalf("registered native view was not routed: %q, %v", id, ok)
	}
	if id, ok := host.SurfaceOwnerID(named, 303); ok || id != "" {
		t.Fatalf("unknown native view activated a surface: %q, %v", id, ok)
	}
	if id, ok := host.SurfaceOwnerID(map[uintptr]string{101: ""}, 101); ok || id != "" {
		t.Fatalf("empty surface owner activated a card: %q, %v", id, ok)
	}
}

// contract: surface-activation.create.propagates-native-failure
func TestLogicalSurfaceCreationPropagatesNativeFailure(t *testing.T) {
	want := errors.New("native surface unavailable")
	_, err := host.CreateLogicalSurfaceHandle(func() (unsafe.Pointer, error) {
		return nil, want
	}, "tab-1")
	if err == nil || !strings.Contains(err.Error(), want.Error()) || !strings.Contains(err.Error(), "tab-1") {
		t.Fatalf("native creation failure was not attributable: %v", err)
	}
}

// contract: surface-activation.create.rejects-nil-handle
func TestLogicalSurfaceCreationRejectsNilHandle(t *testing.T) {
	_, err := host.CreateLogicalSurfaceHandle(func() (unsafe.Pointer, error) {
		return nil, nil
	}, "tab-1")
	if err == nil || !strings.Contains(err.Error(), "nil handle") {
		t.Fatalf("nil native handle was accepted: %v", err)
	}
}
