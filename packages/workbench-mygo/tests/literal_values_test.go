package workbench_test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// paintCalls are the calls of mygo ui that take a length, a share or a color of the look of the window.
var paintCalls = map[string]bool{"FontSize": true, "Size": true, "Width": true, "Height": true, "Gap": true, "Padding": true, "PaddingX": true, "PaddingY": true,
	"Radius": true, "Margin": true, "Border": true, "BorderWidth": true, "MinWidth": true, "MaxWidth": true, "MinHeight": true, "MaxHeight": true, "Left": true, "Top": true,
	"Right": true, "Bottom": true, "Opacity": true, "LineHeight": true, "LetterSpacing": true, "Shadow": true, "Blur": true, "RGBA": true, "Hex": true, "frameFont": true}

// Each look of the window has its value in workbench.json, which the page reads too, so a value that the two workbenches share cannot drift. A call of mygo ui
// that takes a look holds no literal of its own; 0 says that there is none of it.
func TestAPaintCallHoldsNoLiteralValue(t *testing.T) {
	paths, err := filepath.Glob("../src/*.go")
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Fatal("no sources")
	}
	found := []string{}
	for _, path := range paths {
		source, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		files := token.NewFileSet()
		file, err := parser.ParseFile(files, path, source, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || !paintCalls[selector.Sel.Name] {
				return true
			}
			for _, argument := range call.Args {
				if literal, ok := argument.(*ast.BasicLit); ok && literal.Kind != token.IDENT && strings.Trim(literal.Value, "0.") != "" {
					found = append(found, fmt.Sprintf("%s: %s(%s)", files.Position(call.Pos()), selector.Sel.Name, literal.Value))
				}
			}
			return true
		})
	}
	if len(found) > 0 {
		t.Fatalf("%d literal values:\n%s", len(found), strings.Join(found, "\n"))
	}
}
