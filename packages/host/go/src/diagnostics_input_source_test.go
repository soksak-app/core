//go:build diagnostics

package host

import (
	"testing"
)

// contract: diagnostics.input-source.selects-a-role
func TestInputSourceRefusesAStringThatIsNotARole(t *testing.T) {
	for _, params := range []string{`{"select":"source-latin"}`, `{"select":"greek"}`, `{"select":""}`, `{"select":3}`} {
		_, err := parseInputSource([]byte(params))
		if params == `{"select":3}` {
			if err == nil {
				t.Fatalf("accepted %s", params)
			}
			continue
		}
		if err == nil || err.Error() != "-32602: select must be one of latin, korean, japanese" {
			t.Fatalf("params %s error = %v", params, err)
		}
	}
	for params, message := range map[string]string{
		`{"select":"latin","restore":"source-latin"}`: "-32602: select and restore exclude each other",
		`{"restore":""}`: "-32602: restore must be a non-empty string",
	} {
		if _, err := parseInputSource([]byte(params)); err == nil || err.Error() != message {
			t.Fatalf("params %s error = %v", params, err)
		}
	}
}
