package tests

import (
	"testing"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// The schema subset that readers of decoded values check with MatchesSchemaText: each keyword over each kind of JSON value.
func TestTheSchemaTextMatchesEachKindOfValue(t *testing.T) {
	for _, c := range []struct {
		schema, value string
		want          bool
	}{
		{`{"type":"string"}`, `"a"`, true},
		{`{"type":"string"}`, `1`, false},
		{`{"type":["string","null"]}`, `null`, true},
		{`{"type":"integer"}`, `2.5`, false},
		{`{"type":"integer"}`, `2`, true},
		{`{"type":"number"}`, `2.5`, true},
		{`{"type":"boolean"}`, `true`, true},
		{`{"type":"array","items":{"type":"string"}}`, `["a",1]`, false},
		{`{"type":"object","properties":{"a":{"type":"string"}}}`, `{"a":1}`, false},
		{`{"type":"object","properties":{"a":{"type":"string"}}}`, `{"b":1}`, true},
		{`{"enum":["a",{"b":[1]}]}`, `{"b":[1]}`, true},
		{`{"enum":["a"]}`, `"b"`, false},
		{`{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}`, `{}`, false},
		{`{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}`, `{"a":"x"}`, true},
	} {
		got, err := sok.MatchesSchemaText([]byte(c.schema), []byte(c.value))
		if err != nil || got != c.want {
			t.Fatalf("MatchesSchemaText(%s, %s) = %v, %v", c.schema, c.value, got, err)
		}
	}
}
