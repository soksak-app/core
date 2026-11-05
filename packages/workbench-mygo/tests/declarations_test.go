// The declarations that the workbench embeds are the copies of packages/workbench, which make check-exposure holds equal to their
// source (docs/spec/hosts.md#workbench).
package workbench_test

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

func TestTheDeclarationsNameTheEntriesOfTheShell(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	for name, set := range map[string]map[string]bool{
		"core.layout":      declared.Statuses,
		"core.space.add":   declared.Commands,
		"core.chrome.left": declared.Elements,
	} {
		if !set[name] {
			t.Errorf("%s is not declared", name)
		}
	}
	if len(declared.Shortcuts) == 0 {
		t.Error("no shortcut is declared")
	}
	if declared.Shortcuts[0].Key != "cmd+h" {
		t.Errorf("the first shortcut is %+v", declared.Shortcuts[0])
	}
	if metric, ok := declared.Metric("head-h"); !ok || metric <= 0 {
		t.Errorf("the chrome metric head-h is %v, %v", metric, ok)
	}
}

// heldBytes returns the bytes that stay after a collection, for what build returns.
func heldBytes(build func() any) uint64 {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	held := build()
	runtime.GC()
	runtime.ReadMemStats(&after)
	runtime.KeepAlive(held)
	return after.HeapAlloc - min(after.HeapAlloc, before.HeapAlloc)
}

// The declarations stay for the life of the window, so they keep the names and schemas that calls read and leave the
// descriptions that a listing reads to the embedded file.
func TestTheDeclarationsKeepWhatTheyRead(t *testing.T) {
	n := heldBytes(func() any {
		declared, err := workbench.ReadDeclarations()
		if err != nil {
			t.Fatal(err)
		}
		return declared
	})
	if n > 256<<10 {
		t.Errorf("the declarations hold %d kB", n>>10)
	}
}

// A value that a draw reads and the declaration does not hold is a defect of the build: the name is refused, as an element name that is
// not declared is refused, so the chrome does not lay itself out with zero.
func TestAChromeNumberThatIsNotDeclaredIsRefusedWithItsName(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	if number := declared.ChromeNumber("head-h", "px"); number <= 0 {
		t.Errorf("head-h is %v", number)
	}
	refused := func(read func()) (text any) {
		defer func() { text = recover() }()
		read()
		return nil
	}
	for name, read := range map[string]func(){
		"the chrome value no-such-metric is not declared": func() { declared.ChromeNumber("no-such-metric", "px") },
		"the chrome value no-such-text is not declared":   func() { declared.ChromeValue("no-such-text") },
		"the plain control value no-such is not declared": func() { declared.PlainNumber("no-such", "px") },
	} {
		if got := refused(read); got != name {
			t.Errorf("got %v, want %q", got, name)
		}
	}
	if got := refused(func() { declared.ChromeNumber("brand-logo-box", "px") }); got == nil {
		t.Error("a chrome value that is not a number was read as one")
	}
}

// A draw refuses a name that the declaration does not hold, so a name that no test draws would end the application in the hands of a
// person. Each source that reads a name by a literal is read here.
func TestEveryChromeNameThatASourceReadsIsDeclared(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	direct := regexp.MustCompile(`\.Chrome(?:Number|Value)\("([^"]+)"[,)]`)
	plainDirect := regexp.MustCompile(`\.PlainNumber\("([^"]+)"`)
	closure := regexp.MustCompile(`\b(metric|chrome)\("([^"]+)"\)`)
	sources, err := filepath.Glob("../src/*.go")
	if err != nil || len(sources) == 0 {
		t.Fatalf("the sources: %v, %v", sources, err)
	}
	refused := func(read func()) (text any) {
		defer func() { text = recover() }()
		read()
		return nil
	}
	seen := 0
	for _, source := range sources {
		text, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		chrome := func(name string) {
			seen++
			if got := refused(func() { declared.ChromeValue(name) }); got != nil {
				t.Errorf("%s: %v", source, got)
			}
		}
		plain := func(name string) {
			seen++
			if declared.PlainControl(name) == "" {
				t.Errorf("%s: the plain control value %s is not declared", source, name)
			}
		}
		for _, match := range direct.FindAllSubmatch(text, -1) {
			chrome(string(match[1]))
		}
		for _, match := range plainDirect.FindAllSubmatch(text, -1) {
			plain(string(match[1]))
		}
		for _, match := range closure.FindAllSubmatch(text, -1) {
			name := string(match[2])
			switch base := filepath.Base(source); {
			case base == "plain_controls.go" && string(match[1]) == "metric":
				plain(name)
			case base == "picker.go":
				chrome("picker-" + name)
			case base == "settings_draw.go" || base == "shell_debug.go" || base == "plain_controls.go":
				chrome(name)
			default:
				t.Errorf("%s reads %s through a closure that this test does not know", source, name)
			}
		}
	}
	for _, mode := range []string{"brand-text-dark", "brand-text-light"} {
		chrome := mode
		if got := refused(func() { declared.ChromeValue(chrome) }); got != nil {
			t.Error(got)
		}
	}
	if seen < 100 {
		t.Errorf("only %d names were read", seen)
	}
}

// The preview of a theme reads these shape values of each theme, and refuses a theme that does not hold them as numbers.
func TestEveryThemeHoldsTheShapeThatItsPreviewReads(t *testing.T) {
	catalog, err := workbench.ReadSettingsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Themes) == 0 {
		t.Fatal("the catalog holds no theme")
	}
	for _, theme := range catalog.Themes {
		for _, name := range []string{"gap", "r"} {
			if _, err := strconv.ParseFloat(strings.TrimSuffix(theme.Shape[name], "px"), 64); err != nil {
				t.Errorf("theme %s: shape %s: %v", theme.Name, name, err)
			}
		}
	}
}
