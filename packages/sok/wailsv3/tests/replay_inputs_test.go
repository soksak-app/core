package tests

// Runs the golden cases of the replay inputs (docs/spec/cases/log-contract/replay/inputs.json, docs/spec/replay.md#records)
// through the rules of the tool, so the tool refuses an input and a session with the texts of replayInputProblem and
// replaySessionProblem.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

type replayInputCases struct {
	Valid []struct {
		Kind   string          `json:"kind"`
		Fields json.RawMessage `json:"fields"`
	} `json:"valid"`
	Invalid []struct {
		Kind   string          `json:"kind"`
		Fields json.RawMessage `json:"fields"`
		Error  string          `json:"error"`
	} `json:"invalid"`
	Sessions []struct {
		Name   string `json:"name"`
		Inputs []struct {
			Kind   string          `json:"kind"`
			Fields json.RawMessage `json:"fields"`
		} `json:"inputs"`
		Problem *string `json:"problem"`
	} `json:"sessions"`
}

func readReplayInputCases(t *testing.T) replayInputCases {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "docs", "spec", "cases", "log-contract", "replay", "inputs.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases replayInputCases
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

// contract: cli.debug.replay-input-cases
func TestTheReplayInputRulesReproduceTheGoldenCases(t *testing.T) {
	cases := readReplayInputCases(t)
	for _, c := range cases.Valid {
		if problem := sok.ReplayInputProblem(c.Kind, c.Fields); problem != "" {
			t.Errorf("%s %s: refused with %q", c.Kind, c.Fields, problem)
		}
	}
	for _, c := range cases.Invalid {
		if problem := sok.ReplayInputProblem(c.Kind, c.Fields); problem != c.Error {
			t.Errorf("%s %s: problem %q, want %q", c.Kind, c.Fields, problem, c.Error)
		}
	}
	for _, s := range cases.Sessions {
		var inputs []sok.ReplayInput
		for _, input := range s.Inputs {
			inputs = append(inputs, sok.ReplayInput{Kind: input.Kind, Fields: input.Fields})
		}
		want := ""
		if s.Problem != nil {
			want = *s.Problem
		}
		if problem := sok.ReplaySessionProblem(inputs); problem != want {
			t.Errorf("%s: problem %q, want %q", s.Name, problem, want)
		}
	}
}

// contract: cli.debug.replay-session-rules
func TestReplayRefusesASegmentWhoseInputsBreakTheRulesOfASession(t *testing.T) {
	events := standardEvents()
	events.sidecar = events.sidecar[1:]
	config := replayConfig(t, events, fakeReplay, "fake")
	want := "sok: replay session s1: segment b1: input 1 has sequence 2 and the sequence after 0 is 1\n"
	if _, stderr, code := runReplay(t, config, "s1"); code != 1 || stderr != want {
		t.Errorf("no theme: code %d stderr %q, want %q", code, stderr, want)
	}
	// A sidecar that does not name the events of its replay inputs cannot be checked.
	config = replayConfig(t, standardEvents(), fakeReplay, "fake")
	file := filepath.Join(config, "sidecars/probe-worker/1.0.0/darwin-arm64/sidecar.json")
	writeReplayFile(t, file, `{"executable":"worker","displayName":"soksak://sidecar/probe","protocol":1,"replay":{"role":"fake","executable":"replay.sh"}}`, 0o644)
	if _, stderr, code := runReplay(t, config, "s1"); code != 1 || !strings.Contains(stderr, file+": replay.inputs must name the event of the layer sidecar of each kind of replay input; output is \"\"") {
		t.Errorf("no inputs: code %d stderr %q", code, stderr)
	}
}
