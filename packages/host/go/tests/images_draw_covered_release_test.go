//go:build !diagnostics

package host_test

import (
	"reflect"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// A build without the diagnostics tag has no way to make a covered window draw: a person's covered window draws no region.
func TestABuildWithoutDiagnosticsCannotDrawACoveredWindow(t *testing.T) {
	if _, found := reflect.TypeOf(host.NewImages()).MethodByName("SetDrawCovered"); found {
		t.Fatal("Images.SetDrawCovered exists in a build without the diagnostics tag")
	}
}
