package host

import (
	"reflect"
	"testing"
	"unsafe"
)

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
