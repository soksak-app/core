package workbench_test

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"testing"
)

// plainControlReads returns the names of plainControls that the code of the workbench reads. A read is a call of PlainControl
// with a literal name, or of metric or color inside plainControls, which read the table.
func plainControlReads(t *testing.T) map[string]bool {
	t.Helper()
	paths, err := filepath.Glob("../src/*.go")
	if err != nil {
		t.Fatal(err)
	}
	reads := map[string]bool{}
	literal := func(call *ast.CallExpr) {
		if len(call.Args) == 0 {
			return
		}
		if argument, ok := call.Args[0].(*ast.BasicLit); ok && argument.Kind == token.STRING {
			name, err := strconv.Unquote(argument.Value)
			if err != nil {
				t.Fatal(err)
			}
			reads[name] = true
		}
	}
	for _, path := range paths {
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch node := node.(type) {
			case *ast.CallExpr:
				if selector, ok := node.Fun.(*ast.SelectorExpr); ok && (selector.Sel.Name == "PlainControl" || selector.Sel.Name == "PlainNumber") {
					literal(node)
				}
			case *ast.FuncDecl:
				if node.Name.Name == "plainControls" {
					ast.Inspect(node, func(inner ast.Node) bool {
						if call, ok := inner.(*ast.CallExpr); ok {
							if name, ok := call.Fun.(*ast.Ident); ok && (name.Name == "metric" || name.Name == "color") {
								literal(call)
							}
						}
						return true
					})
				}
			}
			return true
		})
	}
	return reads
}

// plainControls holds what the page takes from its browser, which no stylesheet reads. So the native workbench is its reader:
// a value that it does not read is a value without any reader, and a name that it reads without a value draws nothing.
func TestThePlainControlsAndTheirReadersAreTheSameNames(t *testing.T) {
	data, err := os.ReadFile("../src/workbench.json")
	if err != nil {
		t.Fatal(err)
	}
	var declaration struct {
		Plain map[string]string `json:"plainControls"`
	}
	if err := json.Unmarshal(data, &declaration); err != nil {
		t.Fatal(err)
	}
	reads := plainControlReads(t)
	if len(declaration.Plain) == 0 || len(reads) == 0 {
		t.Fatalf("the table holds %d values and the code reads %d", len(declaration.Plain), len(reads))
	}
	unread, undeclared := []string{}, []string{}
	for name := range declaration.Plain {
		if !reads[name] {
			unread = append(unread, name)
		}
	}
	for name := range reads {
		if _, ok := declaration.Plain[name]; !ok {
			undeclared = append(undeclared, name)
		}
	}
	slices.Sort(unread)
	slices.Sort(undeclared)
	if len(unread) > 0 {
		t.Errorf("nothing reads the plain controls %v", unread)
	}
	if len(undeclared) > 0 {
		t.Errorf("the code reads the plain controls %v, which are not declared", undeclared)
	}
}

// Each value of the table has a form that its reader understands: the reader of a length gives 0 for anything else.
func TestThePlainControlsAreColorsOrLengths(t *testing.T) {
	data, err := os.ReadFile("../src/workbench.json")
	if err != nil {
		t.Fatal(err)
	}
	var declaration struct {
		Plain map[string]string `json:"plainControls"`
	}
	if err := json.Unmarshal(data, &declaration); err != nil {
		t.Fatal(err)
	}
	form := regexp.MustCompile(`^(#[0-9a-f]{6}|[0-9]+(\.[0-9]+)?(px|ch))$`)
	for name, value := range declaration.Plain {
		if !form.MatchString(value) {
			t.Errorf("the plain control %s is %q, which is neither a color nor a length", name, value)
		}
	}
}
