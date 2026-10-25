package host

import (
	"reflect"
	"testing"
	"unsafe"
)

// contract: source-origin.generation.javascript-safe-integer-limit
func TestSourceOriginsDoesNotIssueAnUnsafeGeneration(t *testing.T) {
	origins := &sourceOrigins{floor: 1<<53 - 1, pluginHosts: map[string]uint64{}, views: map[string]uint64{}}
	before := origins.snapshot()
	if generation, err := origins.create("probe", false); err == nil || generation != 0 || err.Error() != "source generation exceeds JavaScript safe integer maximum 9007199254740991" {
		t.Fatalf("generation at the JavaScript safe-integer limit returned %d, %v", generation, err)
	}
	if after := origins.snapshot(); !reflect.DeepEqual(after, before) {
		t.Fatalf("source state changed after generation exhaustion: before=%+v after=%+v", before, after)
	}
}

// contract: source-origin.atomic-snapshot-keeps-floor-and-only-current-sources
func TestDeclaredSourceOriginsReturnsCurrentWindowSnapshot(t *testing.T) {
	host, surfaces, _, ctx := projectOpenFixture(t)
	oldPluginGeneration, err := surfaces.sourceOriginState().create("probe", false)
	if err != nil {
		t.Fatal(err)
	}
	viewGeneration, err := surfaces.sourceOriginState().create("tab-one", true)
	if err != nil {
		t.Fatal(err)
	}
	currentPluginGeneration, err := surfaces.sourceOriginState().create("probe", false)
	if err != nil {
		t.Fatal(err)
	}
	if surfaces.sourceOriginState().retire("probe", false, oldPluginGeneration) {
		t.Fatal("retiring a replaced plugin-host generation removed the current source")
	}

	snapshot, err := host.DeclaredSourceOrigins(ctx)
	if err != nil {
		t.Fatalf("read declared-source origins through the host binding: %v", err)
	}
	if snapshot.Floor != currentPluginGeneration || snapshot.PluginHosts["probe"] != currentPluginGeneration || snapshot.Views["tab-one"] != viewGeneration {
		t.Fatalf("active source snapshot %+v, want floor %d, current plugin generation %d, and view generation %d", snapshot, currentPluginGeneration, currentPluginGeneration, viewGeneration)
	}

	if !surfaces.sourceOriginState().retire("probe", false, currentPluginGeneration) || !surfaces.sourceOriginState().retire("tab-one", true, viewGeneration) {
		t.Fatal("retiring the current source generations failed")
	}
	snapshot, err = host.DeclaredSourceOrigins(ctx)
	if err != nil {
		t.Fatalf("read declared-source origins after retirement: %v", err)
	}
	if snapshot.Floor != currentPluginGeneration || len(snapshot.PluginHosts) != 0 || len(snapshot.Views) != 0 {
		t.Fatalf("retired source snapshot %+v, want retained floor %d and no active sources", snapshot, currentPluginGeneration)
	}
}

// contract: plugin-host.startup.refuses-exhausted-source-generation-before-provider
func TestPluginHostStartupReportsGenerationExhaustionBeforeCreatingAProvider(t *testing.T) {
	origins := &sourceOrigins{floor: maxSourceGeneration, pluginHosts: map[string]uint64{}, views: map[string]uint64{}}
	before := origins.snapshot()
	previous := system
	fake := &hostViewPlatform{}
	system = fake
	t.Cleanup(func() { system = previous })
	surfaces := &Surfaces{
		sourceOrigins:      origins,
		pluginHosts:        map[string]unsafe.Pointer{},
		pluginHostChannels: newPluginHostChannels(),
		pluginHostStates:   newPluginHostStates(),
		pluginHostRestarts: newPluginHostRestarts(),
		theme:              Theme{Tokens: map[string]string{}},
	}
	err := surfaces.createPluginHost(unsafe.Pointer(new(int)), hostPlugin{id: "probe", page: "ui/host.html"}, t.TempDir(), t.TempDir())
	if err == nil || err.Error() != "plugin host probe cannot start: source generation exceeds JavaScript safe integer maximum 9007199254740991" {
		t.Fatalf("plugin host creation at generation exhaustion returned %v", err)
	}
	if len(fake.created) != 0 {
		t.Fatalf("plugin host provider was created after generation exhaustion: %v", fake.created)
	}
	if after := origins.snapshot(); !reflect.DeepEqual(after, before) {
		t.Fatalf("source state changed after startup rejected generation exhaustion: before=%+v after=%+v", before, after)
	}
}
