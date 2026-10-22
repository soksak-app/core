package tests

import (
	"encoding/json"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// contract: sok.endpoint.error-member-names-code-and-message
// An error member of an endpoint reply names both its code and its message. A member without either is refused with a named
// error, so no empty message or code is reported for it.
func TestEndpointErrorWithoutAMessageOrACodeIsRefused(t *testing.T) {
	for name, text := range map[string]string{
		"no message": `{"code": -32000}`,
		"no code":    `{"message": "failed"}`,
	} {
		var failure sok.EndpointError
		err := json.Unmarshal([]byte(text), &failure)
		if err == nil || !strings.Contains(err.Error(), "error has no") {
			t.Fatalf("%s: the error member was accepted as %+v (%v)", name, failure, err)
		}
	}
}
