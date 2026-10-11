package tests

// Runs every golden case of the policy file (packages/log-contract/fixtures/policy/cases.json, docs/spec/logging.md#policy-file)
// through the reader of the tool, so the reader of the tool gives the classes, the gate and the error texts that the readers of the
// hosts and of the sidecars give.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

type policyCases struct {
	File  string `json:"file"`
	Valid []struct {
		Name    string            `json:"name"`
		Text    string            `json:"text"`
		Classes map[string]string `json:"classes"`
		Allows  [][2]string       `json:"allows"`
		Refuses [][2]string       `json:"refuses"`
	} `json:"valid"`
	Invalid []struct {
		Name        string `json:"name"`
		Text        string `json:"text"`
		Error       string `json:"error"`
		ErrorPrefix string `json:"error_prefix"`
	} `json:"invalid"`
}

func readPolicyCases(t *testing.T) policyCases {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "log-contract", "fixtures", "policy", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases policyCases
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func TestThePolicyReaderAcceptsEveryValidGoldenCase(t *testing.T) {
	cases := readPolicyCases(t)
	for _, c := range cases.Valid {
		policy, err := sok.ParseLogPolicy(cases.File, []byte(c.Text))
		if err != nil {
			t.Fatalf("%s: refused: %v", c.Name, err)
		}
		classes := policy.Classes()
		for class, value := range c.Classes {
			if classes[class] != value {
				t.Errorf("%s: class %s is %q, expected %q", c.Name, class, classes[class], value)
			}
		}
		for _, pair := range c.Allows {
			if !policy.Allows(sok.Class(pair[0]), sok.Level(pair[1])) {
				t.Errorf("%s: %s %s is refused, expected stored", c.Name, pair[0], pair[1])
			}
		}
		for _, pair := range c.Refuses {
			if policy.Allows(sok.Class(pair[0]), sok.Level(pair[1])) {
				t.Errorf("%s: %s %s is stored, expected refused", c.Name, pair[0], pair[1])
			}
		}
	}
}

func TestThePolicyReaderRefusesEveryInvalidGoldenCaseWithItsText(t *testing.T) {
	cases := readPolicyCases(t)
	for _, c := range cases.Invalid {
		_, err := sok.ParseLogPolicy(cases.File, []byte(c.Text))
		if err == nil {
			t.Errorf("%s: accepted", c.Name)
			continue
		}
		if c.ErrorPrefix != "" {
			if prefix := strings.ReplaceAll(c.ErrorPrefix, "<file>", cases.File); !strings.HasPrefix(err.Error(), prefix) {
				t.Errorf("%s: error %q does not start with %q", c.Name, err, prefix)
			}
			continue
		}
		if expected := strings.ReplaceAll(c.Error, "<file>", cases.File); err.Error() != expected {
			t.Errorf("%s: error %q, expected %q", c.Name, err, expected)
		}
	}
}
