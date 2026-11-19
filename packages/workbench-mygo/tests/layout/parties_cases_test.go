// The party cases of docs/spec/cases/layout/parties.json run against the Go party model. Each case builds the grid from its state,
// then runs its steps in order through layout.Parties: a step with an error must fail with that exact text, and a step with returns
// must reply with every member that the returns name. The same file is run by the party module of packages/workbench.
package layout_test

import (
	"encoding/json"
	"reflect"
	"slices"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
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

// shownPalette returns the party theme tokens of the default theme in its default mode, read from the declaration the page reads.
func shownPalette(t *testing.T) map[string]string {
	t.Helper()
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	palette := map[string]string{}
	for _, token := range []string{"party-1", "party-2", "party-3", "party-4", "party-5", "party-6", "party-leader"} {
		value, err := declared.PartyColor("midnight", "dark", token)
		if err != nil {
			t.Fatal(err)
		}
		palette[token] = value
	}
	return palette
}

// contract: workbench.parties.commands
func TestPartyCasesRunEverySteps(t *testing.T) {
	var file struct {
		Description string `json:"description"`
		Cases       []struct {
			Name    string `json:"name"`
			Drawing *struct {
				RailWidth string  `json:"theme-rail-w"`
				Unit      float64 `json:"unit"`
				Gap       float64 `json:"gap"`
			} `json:"drawing"`
			State layout.State `json:"state"`
			Steps []struct {
				// A layout step names its change and the members of its grid operation (docs/spec/parties.md#changes-of-the-layout).
				Layout   string          `json:"layout"`
				Card     string          `json:"card"`
				Side     string          `json:"side"`
				Born     string          `json:"born"`
				Target   string          `json:"target"`
				Axis     string          `json:"axis"`
				Line     int             `json:"line"`
				Position float64         `json:"position"`
				Call     string          `json:"call"`
				Params   json.RawMessage `json:"params"`
				Returns  json.RawMessage `json:"returns"`
				Error    *string         `json:"error"`
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
			if kase.Drawing != nil {
				gap = kase.Drawing.Gap
				// A drawn case states the rail width its theme declares, and its plane is unit points for each largest line value.
				if rail := shownRailValue(t); rail != kase.Drawing.RailWidth {
					t.Fatalf("%s: the rail width of the case is %s, the theme declares %s", kase.Name, kase.Drawing.RailWidth, rail)
				}
			}
			options := layout.DefaultOptions()
			options.Gap = &gap
			grid, err := layout.New(&state, options)
			if err != nil {
				t.Fatalf("%s: the state of the case is refused: %v", kase.Name, err)
			}
			if kase.Drawing != nil {
				grid.Resize(kase.Drawing.Unit*state.Xs[len(state.Xs)-1], kase.Drawing.Unit*state.Ys[len(state.Ys)-1])
			}
			parties := layout.NewParties(shownPalette(t), shownRail(t))
			for i, s := range kase.Steps {
				if s.Layout != "" {
					// A layout step changes the grid through the grid operation that the shell runs, then corrects the parties
					// through Reconcile, as the shell does after each layout change.
					var change layout.LayoutChange
					switch s.Layout {
					case "close":
						if !grid.Close(s.Card) {
							t.Fatalf("%s: step %d: close %s is refused", kase.Name, i, s.Card)
						}
					case "split":
						born := s.Born
						if id, ok := grid.SplitToward(s.Card, s.Side, layout.SplitInit{ID: &born}); !ok || id != born {
							t.Fatalf("%s: step %d: split %s toward %s made %q, want %s", kase.Name, i, s.Card, s.Side, id, born)
						}
						change.Split = []layout.SplitCard{{Card: s.Card, Born: born}}
					case "move":
						if !grid.Move(s.Card, s.Target, s.Side) {
							t.Fatalf("%s: step %d: move %s to the %s of %s is refused", kase.Name, i, s.Card, s.Side, s.Target)
						}
						change.Moved = []string{s.Card}
					case "boundary":
						grid.MoveBoundary(s.Axis, s.Line, s.Position, false)
						grid.MergeCoincident(s.Axis, s.Line)
					default:
						t.Fatalf("%s: step %d: unknown layout step %s", kase.Name, i, s.Layout)
					}
					rows, err := parties.Reconcile(grid, change)
					if err != nil {
						t.Fatalf("%s: step %d: layout %s: unexpected error %v", kase.Name, i, s.Layout, err)
					}
					text, err := json.Marshal(map[string]any{"changed": rows})
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
					if !reflect.DeepEqual(want, got) {
						t.Fatalf("%s: step %d: layout %s: changed %s, want the returns %s", kase.Name, i, s.Layout, text, s.Returns)
					}
					continue
				}
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

// shownRail returns the rail width of the shown theme in points, which the party border takes (docs/spec/parties.md#drawing).
func shownRail(t *testing.T) float64 {
	t.Helper()
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	return declared.ChromeNumber("theme-rail-w", "px")
}

// shownRailValue returns the rail width of the shown theme as it is declared.
func shownRailValue(t *testing.T) string {
	t.Helper()
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	return declared.ChromeValue("theme-rail-w")
}
