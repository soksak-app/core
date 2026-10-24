//go:build diagnostics

package host

import "testing"

// contract: diagnostics.input-reference.validates-document
func TestInputReferenceValidatesDocument(t *testing.T) {
	for _, action := range []string{"open", "read", "focus", "close"} {
		got, document, err := parseInputReference([]byte(`{"action":"` + action + `"}`))
		if err != nil || got != action || document != nil {
			t.Fatalf("action %s: %s, %v, %v", action, got, document, err)
		}
	}
	for _, document := range []string{`""`, `"a😀"`} {
		_, got, err := parseInputReference([]byte(`{"action":"wait","document":` + document + `}`))
		if err != nil || got == nil {
			t.Fatalf("document %s: %v, %v", document, got, err)
		}
	}
	for _, params := range []string{`null`, `[]`, `{}`, `{"action":"invalid"}`, `{"action":"open","document":null}`, `{"action":"read","document":""}`, `{"action":"close","document":null}`, `{"action":"wait"}`, `{"action":"wait","document":null}`, `{"action":"wait","document":3}`} {
		if _, _, err := parseInputReference([]byte(params)); err == nil {
			t.Fatalf("accepted invalid params %s", params)
		}
	}
}
