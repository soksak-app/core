package workbench_test

import (
	"strings"
	"testing"
)

// The description of the page Sidebar sets is drawn once, by the page head; the group 세트 carries no second copy of it
// (docs/spec/settings.md#pages).
func TestTheSetsPageDrawsItsDescriptionOnce(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "sets"})
	const description = "사이드바에 보여 줄 섹션 묶음"
	count := 0
	for _, text := range f.tester.Texts() {
		if strings.Contains(text, description) {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("the description is drawn %d times; the texts are %q", count, f.tester.Texts())
	}
}
