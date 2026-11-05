// The gate of the declared core names, checked at run time. Each command and status that the exposure declares is in the registry
// of a running shell. Each declared element name stands in the element tree of a frame that a test of this package read: that tells
// that the workbench can show the name to the element requests, and not that a person reaches it.
package workbench_test

import (
	"flag"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// missingNames returns the core names of names that the workbench holds and that have returned false from served.
func missingNames(declared *workbench.Declarations, names map[string]bool, served func(string) bool) []string {
	var absent []string
	for name := range names {
		if strings.HasPrefix(name, "core.") && !declared.HeldByView(name) && !served(name) {
			absent = append(absent, name)
		}
	}
	slices.Sort(absent)
	return absent
}

func TestTheRegistryServesEveryDeclaredCommandAndStatus(t *testing.T) {
	f := newTabShell(t, &storedHost{})
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	commands, statuses := f.shell.Registry().Names()
	if absent := missingNames(declared, declared.Commands, func(name string) bool { return slices.Contains(commands, name) }); len(absent) > 0 {
		t.Errorf("commands without an implementation: %s", strings.Join(absent, " "))
	}
	if absent := missingNames(declared, declared.Statuses, func(name string) bool { return slices.Contains(statuses, name) }); len(absent) > 0 {
		t.Errorf("statuses without an implementation: %s", strings.Join(absent, " "))
	}
}

// elementNamesInATree are the element names of the element trees that the tests read.
var elementNamesInATree = map[string]bool{}

// noteElementNames takes the element names of a tree that a test read.
func noteElementNames(nodes []ui.ElementNode) {
	for _, node := range nodes {
		if exposed, ok := node.Key.(workbench.Exposed); ok {
			elementNamesInATree[exposed.Name] = true
		}
		noteElementNames(node.Children)
	}
}

// TestMain judges the element names after a whole run of the package. A run of chosen tests shows only what they show, so it is not
// judged. The judgment needs every test, which no test of its own can have.
func TestMain(m *testing.M) {
	code := m.Run()
	if flag.Lookup("test.run").Value.String() == "" {
		declared, err := workbench.ReadDeclarations()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		absent := missingNames(declared, declared.Elements, func(name string) bool { return elementNamesInATree[name] })
		if len(absent) > 0 {
			fmt.Fprintf(os.Stderr, "declared element names in the element tree of no test: %s\n", strings.Join(absent, " "))
			code = 1
		}
	}
	os.Exit(code)
}
