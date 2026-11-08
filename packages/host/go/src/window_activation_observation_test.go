package host

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

type activationObservationPlatform struct {
	pageProcessPlatform
	observation json.RawMessage
}

func (p *activationObservationPlatform) WindowFacts(platform.Window) (string, error) {
	facts := map[string]any{"pageProcess": 0, "nativeSurfaces": []any{}, "webviews": []any{}}
	if p.observation != nil {
		facts["activationObservation"] = p.observation
	}
	text, err := json.Marshal(facts)
	return string(text), err
}

// contract: window.facts.activation-observation-is-the-native-object
func TestHostWindowPreservesExactActivationObservation(t *testing.T) {
	for _, raw := range []string{`{"registered":true,"count":"0"}`, `{"registered":false,"count":"18446744073709551615"}`} {
		s := pageProcessSurfaces(t, pagelessFramework{}, 0)
		system = &activationObservationPlatform{observation: json.RawMessage(raw)}
		status, err := s.windowState()
		if err != nil {
			t.Fatal(err)
		}
		text, err := json.Marshal(status)
		if err != nil {
			t.Fatal(err)
		}
		var actual map[string]json.RawMessage
		if err := json.Unmarshal(text, &actual); err != nil {
			t.Fatal(err)
		}
		var got, want any
		if err := json.Unmarshal(actual["activationObservation"], &got); err != nil {
			t.Fatalf("host.window lost activationObservation: %s (%v)", text, err)
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
			s := pageProcessSurfaces(t, pagelessFramework{}, 0)
			var observation json.RawMessage
			if raw != "" {
				observation = json.RawMessage(raw)
			}
			system = &activationObservationPlatform{observation: observation}
			_, err := s.windowState()
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
