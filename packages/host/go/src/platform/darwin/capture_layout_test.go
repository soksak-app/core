//go:build darwin && diagnostics

package darwin

import (
	"math"
	"reflect"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
)

// contract: diagnostics.layout-trace.native-record-names-its-commit
// The native record of a layout transaction holds ticket, begun, presented, committed, requested, the commit path code, the
// number of other CATransaction pairs open at the commit and the time its outermost transaction was sent to the render server. Each code becomes the name of its path, and a transaction
// that did not commit keeps no path.
func TestANativeLayoutRecordNamesItsCommitPath(t *testing.T) {
	nan := math.NaN()
	values := []float64{
		7, 10, 20, 30, 15, abi.SURFACE_LAYOUT_COMMIT_VIEW_JOIN, 1, 35,
		8, 40, 50, 60, 45, abi.SURFACE_LAYOUT_COMMIT_PRESENT, 0, 60,
		9, 70, 80, 90, nan, abi.SURFACE_LAYOUT_COMMIT_START, 0, 90,
		10, 100, nan, 110, nan, abi.SURFACE_LAYOUT_COMMIT_VIEW_ABANDON, 2, 112,
		11, 120, nan, 130, nan, abi.SURFACE_LAYOUT_COMMIT_CANCEL, 0, 130,
		12, 140, nan, nan, nan, nan, nan, nan,
	}
	records, err := layoutRecords(values, 6)
	if err != nil {
		t.Fatal(err)
	}
	paths := make([]string, 0, len(records))
	for _, record := range records {
		paths = append(paths, record.CommitPath)
	}
	if want := []string{"view-join", "present", "start", "view-abandon", "cancel", ""}; !reflect.DeepEqual(paths, want) {
		t.Fatalf("commit paths = %q, want %q", paths, want)
	}
	first := platform.LayoutRecord{Ticket: 7, Begun: 10, Requested: 15, Presented: 20, Committed: 30, CommitPath: "view-join", OpenAtCommit: 1, Flushed: 35}
	if records[0] != first {
		t.Fatalf("first record = %#v, want %#v", records[0], first)
	}
	if last := records[5]; last.Ticket != 12 || !math.IsNaN(last.Committed) || !math.IsNaN(last.OpenAtCommit) || !math.IsNaN(last.Flushed) {
		t.Fatalf("an uncommitted record = %#v", last)
	}
}

// contract: diagnostics.layout-trace.unknown-commit-path-fails
// A commit path code that the native code does not declare is an error, not a record without a path.
func TestANativeLayoutRecordWithAnUnknownCommitPathFails(t *testing.T) {
	if _, err := layoutRecords([]float64{7, 10, 20, 30, 15, 99, 0, 30}, 1); err == nil {
		t.Fatal("an unknown commit path code was accepted")
	}
}
