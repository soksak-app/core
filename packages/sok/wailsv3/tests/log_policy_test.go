package tests

// Runs every golden case of the policy file (packages/log-contract/fixtures/policy/cases.json, docs/spec/logging.md#policy-file)
// through the reader of the tool, so the reader of the tool gives the classes, the gate and the error texts that the readers of the
// hosts and of the sidecars give.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

type policyCases struct {
	File    string            `json:"file"`
	Default map[string]string `json:"default"`
	Valid   []struct {
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

// contract: cli.log.policy-accepts-the-golden-cases
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

// contract: cli.log.policy-refuses-the-golden-cases
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

// The levels of the contract in the order of the file: the level at position i stores with the values from position i+1 up.
var goldenLevels = []sok.Level{sok.LevelError, sok.LevelWarn, sok.LevelInfo, sok.LevelDebug, sok.LevelTrace}

// The default policy is the default of the golden cases: every class at the value of the case, and each level stored or refused as
// the value says. A value at position k of [off, error, warn, info, debug, trace] stores the levels up to position k-1.
// contract: log.policy.default-stores-errors
func TestTheDefaultPolicyIsTheGoldenDefault(t *testing.T) {
	cases := readPolicyCases(t)
	policy := sok.DefaultLogPolicy()
	classes := policy.Classes()
	if len(cases.Default) != len(sok.Classes) {
		t.Fatalf("the golden default names %d classes, expected %d", len(cases.Default), len(sok.Classes))
	}
	for _, class := range sok.Classes {
		value, found := cases.Default[string(class)]
		if !found {
			t.Fatalf("the golden default does not name the class %s", class)
		}
		if classes[string(class)] != value {
			t.Errorf("default class %s is %q, expected %q", class, classes[string(class)], value)
		}
		position := slices.Index([]string{"off", "error", "warn", "info", "debug", "trace"}, value)
		for index, level := range goldenLevels {
			want := index+1 <= position
			if got := policy.Allows(class, level); got != want {
				t.Errorf("default %s %s stored is %v, expected %v for the value %q", class, level, got, want, value)
			}
		}
	}
}

// The tool applies the policy file of its configuration directory at its start, as every process does, so a file that stores every
// level makes the tool store its command event, which the default policy refuses.
// contract: cli.log.applies-the-policy-file
func TestTheToolAppliesThePolicyFileOfItsConfigDirectory(t *testing.T) {
	config := t.TempDir()
	everything := `{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`
	if err := os.WriteFile(filepath.Join(config, "log-policy.json"), []byte(everything), 0o600); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := loggedRun(config, sok.Run, "nothing")
	if code != 2 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	var names []string
	for _, event := range eventsOf(t, config) {
		names = append(names, event.Event)
		if event.Event == "sok.command" {
			return
		}
	}
	t.Fatalf("the tool stored no sok.command under a policy file that stores every level: %v", names)
}

// A policy file that the reader refuses is stored as the error record of the place `log policy`.
// contract: cli.log.records-a-refused-policy-file
func TestARefusedPolicyFileIsStoredAsASokRecordError(t *testing.T) {
	config := t.TempDir()
	if err := os.WriteFile(filepath.Join(config, "log-policy.json"), []byte(`{"schema":9}`), 0o600); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := loggedRun(config, sok.Run, "nothing")
	if code != 2 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	for _, event := range eventsOf(t, config) {
		if event.Event == "sok.record.error" && event.Fields["where"] == "log policy" && strings.Contains(fmt.Sprint(event.Fields["text"]), "schema 9 is not 1") {
			return
		}
	}
	t.Fatalf("no sok.record.error of the place log policy naming schema 9: %+v", eventsOf(t, config))
}
