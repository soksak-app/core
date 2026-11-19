// The party colors of the Go workbench are read from the declaration copy that the Go host embeds, the same declaration that the page
// reads. Each party token of the shown theme and of each mode resolves to a #rrggbb value. The equality of the copy with the workbench
// declaration is checked by scripts/check-hosts-same.mjs, which reads both sources.
package palette_test

import (
	"regexp"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// contract: workbench.parties.drawing
func TestPartyTokensResolveToHexColors(t *testing.T) {
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	tokens := []string{"party-1", "party-2", "party-3", "party-4", "party-5", "party-6", "party-leader"}
	for _, mode := range []string{"dark"} {
		for _, token := range tokens {
			value, err := declared.PartyColor("midnight", mode, token)
			if err != nil {
				t.Fatalf("midnight %s %s: %v", mode, token, err)
			}
			if !hexColor.MatchString(value) {
				t.Errorf("midnight %s %s is %q, which is not #rrggbb", mode, token, value)
			}
		}
	}
}
