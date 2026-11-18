// contract: docs/spec/parties.md#drawing
// The party colors of the Go workbench are read from the declaration of the theme, the same as the page reads them. Each theme and
// each mode of the declaration in packages/workbench/workbench.json resolves the theme tokens party-1 to party-6 and party-leader to
// the value that the declaration states.
package workbench_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

func TestPartyTokensResolveToTheDeclaredColors(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "workbench", "workbench.json"))
	if err != nil {
		t.Fatal(err)
	}
	var source struct {
		Themes []struct {
			Name  string            `json:"name"`
			Dark  map[string]string `json:"dark"`
			Light map[string]string `json:"light"`
		} `json:"themes"`
	}
	if err := json.Unmarshal(text, &source); err != nil {
		t.Fatal(err)
	}
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	tokens := []string{"party-1", "party-2", "party-3", "party-4", "party-5", "party-6", "party-leader"}
	checked := 0
	for _, theme := range source.Themes {
		for mode, palette := range map[string]map[string]string{"dark": theme.Dark, "light": theme.Light} {
			for _, token := range tokens {
				want, ok := palette[token]
				if !ok {
					t.Fatalf("theme %s %s declares no %s", theme.Name, mode, token)
				}
				got, err := declared.PartyColor(theme.Name, mode, token)
				if err != nil {
					t.Fatalf("theme %s %s %s: %v", theme.Name, mode, token, err)
				}
				if got != want {
					t.Errorf("theme %s %s %s resolves to %s, the declaration states %s", theme.Name, mode, token, got, want)
				}
				checked++
			}
		}
	}
	if checked == 0 {
		t.Fatal(fmt.Sprintf("no party token was checked in %d themes", len(source.Themes)))
	}
}
