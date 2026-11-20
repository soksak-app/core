//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"testing"
)

// The method that dispatches the action of a person is a diagnostic method.
// contract: diagnostics.input-person.declared
func TestInputPersonIsADiagnosticMethod(t *testing.T) {
	if _, found := diagnosticMethods["diagnostics.input.person"]; !found {
		t.Fatal("diagnostics.input.person is not a diagnostic method")
	}
}

// The action of a person refuses an action or a point out of its form before it looks for the window or calls the platform.
// contract: diagnostics.input-person.validates-parameters
func TestInputPersonRefusesParametersOutOfTheirForm(t *testing.T) {
	method, found := diagnosticMethods["diagnostics.input.person"]
	if !found {
		t.Fatal("diagnostics.input.person is not a diagnostic method")
	}
	for _, test := range []struct{ params, want string }{
		{`{"window":"w","action":"drag","x":1,"y":2}`, "action must be press, move or scroll"},
		{`{"window":"w","x":1,"y":2}`, "action must be press, move or scroll"},
		{`{"window":"w","action":7,"x":1,"y":2}`, "action must be press, move or scroll"},
		{`{"window":"w","action":"move","y":2}`, "x and y must be numbers"},
		{`{"window":"w","action":"move","x":"1","y":2}`, "x and y must be numbers"},
		{`{"window":"w","action":"scroll","x":1,"y":null}`, "x and y must be numbers"},
	} {
		_, err := method(&Endpoint{}, nil, json.RawMessage(test.params), nil)
		var coded *RPCError
		if !errors.As(err, &coded) || coded.Code != codeInvalidParams || coded.Message != test.want {
			t.Fatalf("%s answered %v, want %d %q", test.params, err, codeInvalidParams, test.want)
		}
	}
}
