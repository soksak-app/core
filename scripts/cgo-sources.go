// Prints, for each Go file that a line of the standard input names, the cgo preamble with the line of its first line, the
// flags of its #cgo CFLAGS lines, the functions that the file exports to C, and the calls of C functions, as a JSON array.
// go/parser reads the files; the preamble is the comment of import "C" and its #cgo lines are blank, as cmd/cgo reads them.
// scripts/check-hosts.mjs runs it for the main-thread audit of the darwin layer of the Wails host (docs/spec/hosts.md, main
// thread of the Wails host). The paths come from the standard input because go run takes every .go argument as a file of the
// program.
//
//	go run scripts/cgo-sources.go < paths
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"strings"
)

type preamble struct {
	Line int    `json:"line"`
	Text string `json:"text"`
}

type call struct {
	Name string `json:"name"`
	Line int    `json:"line"`
}

type source struct {
	File     string    `json:"file"`
	Preamble *preamble `json:"preamble"`
	CFlags   []string  `json:"cflags"`
	Exports  []string  `json:"exports"`
	Calls    []call    `json:"calls"`
}

// preambleOf returns the comment of import "C" with each comment at its own line, as cmd/cgo takes it: the comment of the
// import specification, or the comment of its declaration when the declaration holds only that specification.
func preambleOf(fset *token.FileSet, file *ast.File) *preamble {
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.IMPORT {
			continue
		}
		for _, spec := range gen.Specs {
			imported := spec.(*ast.ImportSpec)
			if imported.Path.Value != `"C"` {
				continue
			}
			group := imported.Doc
			if group == nil && len(gen.Specs) == 1 {
				group = gen.Doc
			}
			if group == nil {
				return &preamble{Line: fset.Position(imported.Pos()).Line, Text: ""}
			}
			first := fset.Position(group.Pos()).Line
			var text strings.Builder
			line := first
			for _, comment := range group.List {
				for start := fset.Position(comment.Pos()).Line; line < start; line++ {
					text.WriteString("\n")
				}
				body := comment.Text
				if strings.HasPrefix(body, "//") {
					body = body[2:]
				} else {
					body = strings.TrimSuffix(strings.TrimPrefix(body, "/*"), "*/")
				}
				text.WriteString(body)
				line += strings.Count(body, "\n")
			}
			lines := strings.Split(text.String(), "\n")
			for i, value := range lines {
				if strings.HasPrefix(strings.TrimSpace(value), "#cgo") {
					lines[i] = ""
				}
			}
			return &preamble{Line: first, Text: strings.Join(lines, "\n")}
		}
	}
	return nil
}

func read(fset *token.FileSet, path string) (source, error) {
	file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		return source{}, err
	}
	result := source{File: path, Preamble: preambleOf(fset, file), CFlags: []string{}, Exports: []string{}, Calls: []call{}}
	for _, group := range file.Comments {
		for _, line := range strings.Split(group.Text(), "\n") {
			if flags, found := strings.CutPrefix(strings.TrimSpace(line), "#cgo CFLAGS:"); found {
				result.CFlags = append(result.CFlags, strings.Fields(flags)...)
			}
		}
	}
	for _, decl := range file.Decls {
		function, ok := decl.(*ast.FuncDecl)
		if !ok || function.Doc == nil {
			continue
		}
		for _, comment := range function.Doc.List {
			if name, found := strings.CutPrefix(comment.Text, "//export "); found {
				result.Exports = append(result.Exports, strings.TrimSpace(name))
			}
		}
	}
	ast.Inspect(file, func(node ast.Node) bool {
		expression, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		if selector, ok := expression.Fun.(*ast.SelectorExpr); ok {
			if receiver, ok := selector.X.(*ast.Ident); ok && receiver.Name == "C" {
				result.Calls = append(result.Calls, call{Name: selector.Sel.Name, Line: fset.Position(selector.Sel.Pos()).Line})
			}
		}
		return true
	})
	return result, nil
}

func main() {
	fset := token.NewFileSet()
	sources := []source{}
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, path := range strings.Fields(string(input)) {
		result, err := read(fset, path)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		sources = append(sources, result)
	}
	if err := json.NewEncoder(os.Stdout).Encode(sources); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
