package host

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// activationObservationFacts is the native window facts text with the activationObservation member raw, or without one when raw
// is empty.
func activationObservationFacts(raw string) string {
	member := ""
	if raw != "" {
		member = `,"activationObservation":` + raw
	}
	return `{"pageProcess":0,"nativeSurfaces":[],"webviews":[]` + member + `}`
}

// contract: window.facts.activation-observation-is-the-native-object
func TestHostWindowPreservesExactActivationObservation(t *testing.T) {
	for _, raw := range []string{`{"registered":true,"count":"0"}`, `{"registered":false,"count":"18446744073709551615"}`} {
		actual, err := windowStatusMembers(t, activationObservationFacts(raw), false)
		if err != nil {
			t.Fatal(err)
		}
		var got, want any
		if err := json.Unmarshal(actual["activationObservation"], &got); err != nil {
			t.Fatalf("host.window lost activationObservation: %s (%v)", actual["activationObservation"], err)
		}
		if err := json.Unmarshal([]byte(raw), &want); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("activation observation changed: got %v want %v", got, want)
		}
	}
}

// contract: window.facts.activation-observation-refuses-invalid-native-evidence
func TestHostWindowRefusesMissingOrInvalidActivationObservation(t *testing.T) {
	for _, raw := range []string{"", `null`, `{}`, `{"registered":true}`, `{"count":"1"}`, `{"registered":"true","count":"1"}`, `{"registered":false,"count":1}`, `{"registered":false,"count":""}`, `{"registered":false,"count":"01"}`, `{"registered":false,"count":"-1"}`, `{"registered":false,"count":"+1"}`, `{"registered":false,"count":"1.0"}`, `{"registered":false,"count":"18446744073709551616"}`} {
		t.Run(raw, func(t *testing.T) {
			_, err := windowStatusMembers(t, activationObservationFacts(raw), false)
			if err == nil || !strings.Contains(err.Error(), "activationObservation") {
				t.Fatalf("invalid native activationObservation %q returned %v", raw, err)
			}
		})
	}
}

// contract: window.facts.activation-observation-declares-its-schema
func TestHostWindowDeclaresExactActivationObservationSchema(t *testing.T) {
	props := hostStatus["host.window"].Schema["properties"].(map[string]any)
	declaration, ok := props["activationObservation"].(map[string]any)
	if !ok {
		t.Fatal("host.window has no activationObservation schema")
	}
	fields, ok := declaration["properties"].(map[string]any)
	if !ok {
		t.Fatal("activationObservation has no properties")
	}
	if !reflect.DeepEqual(fields["registered"], map[string]any{"type": "boolean"}) ||
		!reflect.DeepEqual(fields["count"], map[string]any{"type": "string", "pattern": "^(0|[1-9][0-9]*)$"}) {
		t.Fatalf("activationObservation schema does not preserve native bool/decimal-string fields: %v", fields)
	}
}
