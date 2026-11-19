// The shared cases of the colors of a group card (docs/spec/cases/group-look.json, docs/spec/groups.md#drawing). groupLook of
// packages/workbench/group-look.js runs the same file, so a case is one statement of the drawing that both workbenches meet.
package workbench_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// hexOf is the text #rrggbb of an opaque color.
func hexOf(c ui.Color) string { return fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B) }

func TestGroupLookCases(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "spec", "cases", "group-look.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Description string `json:"description"`
		Cases       []struct {
			Name    string            `json:"name"`
			Tokens  map[string]string `json:"tokens"`
			Level   int               `json:"level"`
			Seam    bool              `json:"seam"`
			Fade    float64           `json:"fade"`
			Returns map[string]string `json:"returns"`
		} `json:"cases"`
	}
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		t.Fatal(err)
	}
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			palette := workbench.Palette{Bg: ui.Hex(kase.Tokens["bg"]), Card: ui.Hex(kase.Tokens["card"]), Edge: ui.Hex(kase.Tokens["edge"]),
				Rule: ui.Hex(kase.Tokens["rule"]), Gap: 12, BorderWidth: 1}
			if kase.Seam {
				palette.Gap = 0
			}
			look := palette.GroupLook(kase.Level, kase.Fade)
			if got := map[string]string{"head": hexOf(look.Head), "line": hexOf(look.Line), "body": hexOf(look.Body)}; fmt.Sprint(got) != fmt.Sprint(kase.Returns) {
				t.Errorf("the look is %v, want %v", got, kase.Returns)
			}
		})
	}
}
