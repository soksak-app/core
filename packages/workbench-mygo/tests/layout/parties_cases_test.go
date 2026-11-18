// contract: docs/spec/parties.md#commands
// The party cases of docs/spec/cases/layout/parties.json run against the Go party model. Each case builds the grid from its state,
// then runs its steps in order through layout.Parties: a step with an error must fail with that exact text, and a step with returns
// must reply with every member that the returns name. The same file is run by the party module of packages/workbench.
package layout_test

import (
	"encoding/json"
	"reflect"
	"slices"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// subsetOf tells whether every member that want names is in got with the same value; arrays match element by element and in length.
func subsetOf(want, got any) bool {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return false
		}
		for key, value := range w {
			if !subsetOf(value, g[key]) {
				return false
			}
		}
		return true
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return false
		}
		for i := range w {
			if !subsetOf(w[i], g[i]) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(want, got)
	}
}

func sortedKeys(set map[float64]bool) []float64 {
	keys := make([]float64, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

// sameReply compares a reply with the returns of a step as the owning JavaScript test does: each member that the returns name is
// equal in the reply, and a party member is compared on the keys that the returns name, because a case states the fields it checks.
func sameReply(want, got any) bool {
	wantMap, wantOK := want.(map[string]any)
	gotMap, gotOK := got.(map[string]any)
	if !wantOK || !gotOK {
		return false
	}
	for key, value := range wantMap {
		if key == "party" {
			wantParty, isObject := value.(map[string]any)
			if !isObject {
				if !reflect.DeepEqual(value, gotMap[key]) {
					return false
				}
				continue
			}
			if !subsetOf(wantParty, gotMap[key]) {
				return false
			}
			continue
		}
		if !reflect.DeepEqual(value, gotMap[key]) {
			return false
		}
	}
	return true
}

func TestPartyCasesRunEverySteps(t *testing.T) {
	var file struct {
		Description string `json:"description"`
		Cases       []struct {
			Name  string       `json:"name"`
			State layout.State `json:"state"`
			Steps []struct {
				Call    string          `json:"call"`
				Params  json.RawMessage `json:"params"`
				Returns json.RawMessage `json:"returns"`
				Error   *string         `json:"error"`
			} `json:"steps"`
		} `json:"cases"`
	}
	caseFile(t, "parties.json", &file)
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			// The case states hold the cards only: the lines are the sorted edges of the cards, with no gap, as the owning JavaScript test builds them.
			xs, ys := map[float64]bool{}, map[float64]bool{}
			for _, card := range kase.State.Cards {
				xs[float64(card.C0)], xs[float64(card.C1)] = true, true
				ys[float64(card.R0)], ys[float64(card.R1)] = true, true
			}
			state := layout.State{Xs: sortedKeys(xs), Ys: sortedKeys(ys), Cards: kase.State.Cards}
			gap := 0.0
			options := layout.DefaultOptions()
			options.Gap = &gap
			grid, err := layout.New(&state, options)
			if err != nil {
				t.Fatalf("%s: the state of the case is refused: %v", kase.Name, err)
			}
			parties := layout.NewParties()
			for i, s := range kase.Steps {
				reply, err := parties.Run(grid, s.Call, s.Params)
				if s.Error != nil {
					if err == nil || err.Error() != *s.Error {
						t.Fatalf("%s: step %d %s: error %v, want %q", kase.Name, i, s.Call, err, *s.Error)
					}
					continue
				}
				if err != nil {
					t.Fatalf("%s: step %d %s: unexpected error %v", kase.Name, i, s.Call, err)
				}
				if string(s.Returns) == "null" || len(s.Returns) == 0 {
					continue
				}
				text, err := json.Marshal(reply)
				if err != nil {
					t.Fatal(err)
				}
				var got, want any
				if err := json.Unmarshal(text, &got); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(s.Returns, &want); err != nil {
					t.Fatal(err)
				}
				if !sameReply(want, got) {
					t.Fatalf("%s: step %d %s: reply %s, want the returns %s", kase.Name, i, s.Call, text, s.Returns)
				}
			}
		})
	}
}
