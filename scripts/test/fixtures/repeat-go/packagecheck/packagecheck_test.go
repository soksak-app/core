package packagecheck

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ran holds the names of the tests that ran in this process.
var ran = map[string]bool{}

func TestAlpha(t *testing.T) { ran["TestAlpha"] = true }

func TestBeta(t *testing.T) { ran["TestBeta"] = true }

// TestMain checks that every test that FIXTURE_REQUIRED names, separated by commas, ran. Under the test runner each test runs in a
// process of its own that writes the names of its tests into the folder SOKSAK_TEST_RECORDS, and the check of the package, with
// SOKSAK_TEST_PACKAGE_CHECK, reads every file there (docs/operations/examples.md#test-parity); a plain go test of the package checks
// the tests of its own process, and a listing of the tests checks nothing.
func TestMain(m *testing.M) {
	code := m.Run()
	records := os.Getenv("SOKSAK_TEST_RECORDS")
	checked := false
	switch {
	case os.Getenv("SOKSAK_TEST_PACKAGE_CHECK") != "":
		files, err := filepath.Glob(filepath.Join(records, "ran-*.txt"))
		if err != nil || len(files) == 0 {
			fmt.Fprintf(os.Stderr, "the folder %q holds no records of a test: %v\n", records, err)
			os.Exit(1)
		}
		for _, path := range files {
			text, err := os.ReadFile(path)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			for _, name := range strings.Fields(string(text)) {
				ran[name] = true
			}
		}
		checked = true
	case records != "":
		file, err := os.CreateTemp(records, "ran-*.txt")
		if err == nil {
			for name := range ran {
				if _, err = fmt.Fprintln(file, name); err != nil {
					break
				}
			}
			if closed := file.Close(); err == nil {
				err = closed
			}
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			code = 1
		}
	default:
		checked = flag.Lookup("test.run").Value.String() == "" && flag.Lookup("test.list").Value.String() == ""
	}
	if checked {
		for _, name := range strings.Split(os.Getenv("FIXTURE_REQUIRED"), ",") {
			if name != "" && !ran[name] {
				fmt.Fprintf(os.Stderr, "the required test %s did not run\n", name)
				code = 1
			}
		}
	}
	os.Exit(code)
}
