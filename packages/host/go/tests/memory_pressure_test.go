// Memory pressure level tests (docs/spec/hosts.md#memory-pressure). The relay of the reports of the native source runs on the
// main thread and is tested in tests/platform/darwin/system.
package host_test

import (
	"encoding/json"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

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
