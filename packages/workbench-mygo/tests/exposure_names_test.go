// The gate of the declared core names, checked at run time. Each command and status that the exposure declares is in the registry
// of a running shell. Each declared element name stands in the element tree of a frame that a test of this package read: that tells
// that the workbench can show the name to the element requests, and not that a person reaches it.
package workbench_test

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
	testplatform "github.com/soksak-app/core/packages/host/go/tests/platform"
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

// pressedAt presses the point and returns the status core.pointer of the press.
func pressedAt(t *testing.T, f *shellFixture, x, y float32) workbench.PointerStatus {
	t.Helper()
	before := status[workbench.PointerStatus](t, f, "core.pointer").Sequence
	f.tester.ClickAt(x, y)
	f.settle()
	got := status[workbench.PointerStatus](t, f, "core.pointer")
	if got.Sequence != before+1 {
		t.Fatalf("the press at %v, %v is the sequence %d after %d", x, y, got.Sequence, before)
	}
	return got
}

// The places of the workbench that declare no name, which the page reports by the tag of a plain element and this host as the
// specification states (docs/spec/exposure.md#workbench-statuses). A name that one of them takes belongs in the exposure.
func TestAPlaceWithoutADeclaredNameStaysEmpty(t *testing.T) {
	f := openedShell(t)
	f.settle()
	add := f.box("core.space-tab.add", "")
	for _, place := range []struct {
		name string
		x, y float32
	}{
		{"the space row beside its tabs", add.X + add.W + 40, add.Y + add.H/2},
		{"the left margin of the plane", 2, 400},
		{"the right margin of the plane", 1198, 400},
		{"the bottom margin of the plane", 600, 798},
	} {
		got := pressedAt(t, f, place.x, place.y)
		if *got.Down != "unknown" || *got.Up != "unknown" || *got.Click != "unknown" || got.PressedConnected != nil {
			t.Errorf("%s is %s, %s, %s", place.name, *got.Down, *got.Up, *got.Click)
		}
	}
	f.run("core.projects.browse", nil)
	if got := pressedAt(t, f, 600, 790); *got.Down != "unknown" || got.PressedConnected != nil {
		t.Errorf("the foot of the project home is %s", *got.Down)
	}
	if got := pressedAt(t, f, 1100, 500); *got.Down != "region" || *got.Click != "region" {
		t.Errorf("the body of the project home is %s, %s", *got.Down, *got.Click)
	}
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

// TestMain judges the element names after a whole run of the package. A run of chosen tests shows only what they show, and a listing
// of the tests runs none, so neither is judged. The judgment needs every test, which no test of its own can have. The test runner runs
// each test in a process of its own and then the check of the package (docs/operations/examples.md#test-parity): with
// SOKSAK_TEST_RECORDS each test process writes the names that its test read into a file of that folder, and the check, with
// SOKSAK_TEST_PACKAGE_CHECK, judges the names of every file there.
func TestMain(m *testing.M) {
	testplatform.InstallMainThread()
	code := m.Run()
	records := os.Getenv("SOKSAK_TEST_RECORDS")
	judged := false
	switch {
	case os.Getenv("SOKSAK_TEST_PACKAGE_CHECK") != "":
		if err := readElementNames(records); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		judged = true
	case records != "":
		if err := writeElementNames(records); err != nil {
			fmt.Fprintln(os.Stderr, err)
			code = 1
		}
	default:
		judged = flag.Lookup("test.run").Value.String() == "" && flag.Lookup("test.list").Value.String() == ""
	}
	if judged {
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

// writeElementNames writes the element names that the tests of this process read into a new file of the folder records, one per line.
func writeElementNames(records string) error {
	file, err := os.CreateTemp(records, "element-names-*.txt")
	if err != nil {
		return fmt.Errorf("the element names of the tests: %w", err)
	}
	names := make([]string, 0, len(elementNamesInATree))
	for name := range elementNamesInATree {
		names = append(names, name)
	}
	slices.Sort(names)
	if _, err := file.WriteString(strings.Join(names, "\n")); err != nil {
		file.Close()
		return fmt.Errorf("the element names of the tests: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("the element names of the tests: %w", err)
	}
	return nil
}

// readElementNames takes the element names of every file of the folder records that the tests of the package wrote.
func readElementNames(records string) error {
	if records == "" {
		return fmt.Errorf("SOKSAK_TEST_PACKAGE_CHECK needs the folder SOKSAK_TEST_RECORDS")
	}
	files, err := filepath.Glob(filepath.Join(records, "element-names-*.txt"))
	if err != nil {
		return fmt.Errorf("the element names of %s: %w", records, err)
	}
	if len(files) == 0 {
		return fmt.Errorf("%s holds no element names of a test", records)
	}
	for _, path := range files {
		text, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("the element names of %s: %w", path, err)
		}
		for _, name := range strings.Split(string(text), "\n") {
			if name != "" {
				elementNamesInATree[name] = true
			}
		}
	}
	return nil
}
