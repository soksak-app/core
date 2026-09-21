package host_test

import (
	"testing"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

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
