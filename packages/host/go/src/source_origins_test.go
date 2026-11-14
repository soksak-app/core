package host

import (
	"reflect"
	"testing"
)

// contract: source-origin.generation.javascript-safe-integer-limit
func TestSourceOriginsDoesNotIssueAnUnsafeGeneration(t *testing.T) {
	origins := &sourceOrigins{floor: 1<<53 - 1, views: map[string]uint64{}}
	before := origins.snapshot()
	if generation, err := origins.create("probe"); err == nil || generation != 0 || err.Error() != "view source generation exceeds the JavaScript safe integer limit" {
		t.Fatalf("generation at the JavaScript safe-integer limit returned %d, %v", generation, err)
	}
	if after := origins.snapshot(); !reflect.DeepEqual(after, before) {
		t.Fatalf("source state changed after generation exhaustion: before=%+v after=%+v", before, after)
	}
}

// A view reply, event and request whose generation is above the JavaScript safe integer limit is refused with the text of both hosts.
// contract: view.source-generation
func TestAViewMessageAboveTheSafeIntegerLimitIsRefused(t *testing.T) {
	for _, where := range []string{"view request", "view reply", "view event"} {
		want := where + " source generation exceeds the JavaScript safe integer limit"
		if err := validateViewGeneration(where, 9_007_199_254_740_992); err == nil || err.Error() != want {
			t.Fatalf("%s above the limit: %v, want %s", where, err, want)
		}
		if err := validateViewGeneration(where, 9_007_199_254_740_991); err != nil {
			t.Fatalf("%s at the limit: %v", where, err)
		}
	}
}

// contract: source-origin.atomic-snapshot-keeps-floor-and-only-current-sources
func TestViewSourceOriginsReturnsCurrentWindowSnapshot(t *testing.T) {
	host, surfaces, ctx := projectOpenFixture(t)
	oldGeneration, err := surfaces.sourceOriginState().create("tab-one")
	if err != nil {
		t.Fatal(err)
	}
	currentGeneration, err := surfaces.sourceOriginState().create("tab-one")
	if err != nil {
		t.Fatal(err)
	}
	if surfaces.sourceOriginState().retire("tab-one", oldGeneration) {
		t.Fatal("retiring a replaced view generation removed the current source")
	}

	snapshot, err := host.ViewSourceOrigins(ctx)
	if err != nil {
		t.Fatalf("read view-source origins through the host binding: %v", err)
	}
	if snapshot.Floor != currentGeneration || snapshot.Views["tab-one"] != currentGeneration || len(snapshot.Views) != 1 {
		t.Fatalf("active source snapshot %+v, want floor %d and view generation %d", snapshot, currentGeneration, currentGeneration)
	}

	if !surfaces.sourceOriginState().retire("tab-one", currentGeneration) {
		t.Fatal("retiring the current source generation failed")
	}
	snapshot, err = host.ViewSourceOrigins(ctx)
	if err != nil {
		t.Fatalf("read view-source origins after retirement: %v", err)
	}
	if snapshot.Floor != currentGeneration || len(snapshot.Views) != 0 {
		t.Fatalf("retired source snapshot %+v, want retained floor %d and no active sources", snapshot, currentGeneration)
	}
}
