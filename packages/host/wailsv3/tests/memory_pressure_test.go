// Memory pressure relay tests (docs/spec/hosts.md#memory-pressure). A fake source stands for the native owner, which the native
// test memory_pressure_test checks.
package host_test

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// fakeMemoryPressureSource keeps the report function that the host registers.
type fakeMemoryPressureSource struct {
	report func(level string, seq uint64)
	err    error
}

func (f *fakeMemoryPressureSource) OnMemoryPressure(report func(level string, seq uint64)) error {
	f.report = report
	return f.err
}

// contract: host.memory-pressure.relays-level-and-seq
func TestMemoryPressureRelaysLevelAndSeq(t *testing.T) {
	type emitted struct {
		name    string
		payload any
	}
	sent := make(chan emitted, 4)
	source := &fakeMemoryPressureSource{}
	if err := host.StartMemoryPressure(source, func(name string, payload any) { sent <- emitted{name, payload} }); err != nil {
		t.Fatal(err)
	}
	if source.report == nil {
		t.Fatal("the host registered no report function")
	}
	source.report("warn", 1)
	source.report("normal", 2)
	for _, want := range []emitted{
		{"memory-pressure", map[string]any{"level": "warn", "seq": uint64(1)}},
		{"memory-pressure", map[string]any{"level": "normal", "seq": uint64(2)}},
	} {
		select {
		case got := <-sent:
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("sent %#v, want %#v", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no emit of %#v within 5 seconds", want)
		}
	}
	failing := &fakeMemoryPressureSource{err: errors.New("failed to start the memory pressure source")}
	if err := host.StartMemoryPressure(failing, func(string, any) {}); err == nil || err.Error() != "failed to start the memory pressure source" {
		t.Fatalf("a refused source returned %v", err)
	}
}

// contract: host.memory-pressure.relays-level-and-seq
func TestMemoryPressureReportsArriveInSeqOrderWithoutWaiting(t *testing.T) {
	release := make(chan struct{})
	sent := make(chan string, 4)
	source := &fakeMemoryPressureSource{}
	if err := host.StartMemoryPressure(source, func(name string, payload any) {
		level := payload.(map[string]any)["level"].(string)
		if level == "critical" {
			<-release
		}
		sent <- level
	}); err != nil {
		t.Fatal(err)
	}
	reported := make(chan struct{})
	go func() {
		source.report("critical", 1)
		source.report("normal", 2)
		close(reported)
	}()
	select {
	case <-reported:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("a report waited for the emit of an earlier report")
	}
	close(release)
	for _, want := range []string{"critical", "normal"} {
		select {
		case got := <-sent:
			if got != want {
				t.Fatalf("emitted %q, want %q in seq order", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no emit of %q within 5 seconds", want)
		}
	}
}

// contract: diagnostics.memory-pressure.level-validates
func TestMemoryPressureLevelValidates(t *testing.T) {
	for _, level := range []string{"normal", "warn", "critical"} {
		raw, _ := json.Marshal(level)
		if got, err := host.ParseMemoryPressureLevel(raw); err != nil || got != level {
			t.Errorf("ParseMemoryPressureLevel(%s) = %q, %v", raw, got, err)
		}
	}
	for _, raw := range []string{``, `null`, `"severe"`, `"Warn"`, `1`, `{}`} {
		if _, err := host.ParseMemoryPressureLevel(json.RawMessage(raw)); err == nil || err.Error() != "level must be normal, warn or critical" {
			t.Errorf("ParseMemoryPressureLevel(%q) error = %v", raw, err)
		}
	}
}
