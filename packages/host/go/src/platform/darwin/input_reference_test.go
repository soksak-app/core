//go:build darwin && diagnostics

package darwin

import (
	"encoding/json"
	"strings"
	"testing"
)

// contract: diagnostics.input-reference.rejects-nul
func TestInputReferenceRejectsNUL(t *testing.T) {
	nul := "a\x00b"
	for _, request := range []struct {
		action   string
		document *string
	}{{nul, nil}, {"wait", &nul}} {
		count := 0
		implementation{}.InputReference(nil, request.action, request.document, func(value json.RawMessage, err error) {
			count++
			if value != nil || err == nil || !strings.Contains(err.Error(), "NUL") {
				t.Fatalf("reply %s, %v", value, err)
			}
		})
		if count != 1 {
			t.Fatalf("callback count = %d", count)
		}
	}
}
