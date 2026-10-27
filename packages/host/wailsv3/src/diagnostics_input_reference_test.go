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
		gotAction, got, err := parseInputReference([]byte(`{"action":"wait","document":` + document + `}`))
		if err != nil || gotAction != "wait" || got == nil {
			t.Fatalf("wait document %s: %s, %v, %v", document, gotAction, got, err)
		}
	}
	for _, params := range []string{`null`, `[]`, `{}`, `{"action":"invalid"}`, `{"action":"open","document":null}`, `{"action":"read","document":""}`, `{"action":"close","document":null}`, `{"action":"wait"}`, `{"action":"wait","document":null}`, `{"action":"wait","document":3}`} {
		if _, _, err := parseInputReference([]byte(params)); err == nil {
			t.Fatalf("accepted invalid params %s", params)
		}
	}
	_, _, err := parseInputReference([]byte(`{"action":"invalid"}`))
	if err == nil || err.Error() != "-32602: input reference action must be open, read, focus, wait-document, wait or close" {
		t.Fatalf("invalid action error = %v", err)
	}
}

// contract: diagnostics.input-reference.validates-document
func TestInputReferenceWaitDocumentAcceptsExpectedDocument(t *testing.T) {
	for _, test := range []struct{ json, value string }{{`""`, ""}, {`"a😀"`, "a😀"}} {
		gotAction, got, err := parseInputReference([]byte(`{"action":"wait-document","document":` + test.json + `}`))
		if err != nil || gotAction != "wait-document" || got == nil || *got != test.value {
			t.Fatalf("wait-document %s: %s, %v, %v", test.json, gotAction, got, err)
		}
	}
}

// contract: diagnostics.input-reference.validates-document
func TestInputReferenceWaitDocumentRequiresAString(t *testing.T) {
	for _, params := range []string{`{"action":"wait-document"}`, `{"action":"wait-document","document":null}`, `{"action":"wait-document","document":3}`} {
		_, _, err := parseInputReference([]byte(params))
		if err == nil || err.Error() != "-32602: input reference wait-document and wait require a document string" {
			t.Errorf("wait-document params %s error = %v", params, err)
		}
	}
}

// contract: diagnostics.input-reference.validates-document
func TestInputReferenceDocumentErrorNamesBothWaitActions(t *testing.T) {
	_, _, err := parseInputReference([]byte(`{"action":"read","document":"text"}`))
	if err == nil || err.Error() != "-32602: input reference document is only for wait-document and wait" {
		t.Fatalf("unexpected document scope error = %v", err)
	}
}

// contract: diagnostics.input-reference.validates-document
func TestInputReferenceWaitDocumentActionErrorNamesAction(t *testing.T) {
	_, _, err := parseInputReference([]byte(`{"action":"invalid"}`))
	if err == nil || err.Error() != "-32602: input reference action must be open, read, focus, wait-document, wait or close" {
		t.Fatalf("invalid action error = %v", err)
	}
}
