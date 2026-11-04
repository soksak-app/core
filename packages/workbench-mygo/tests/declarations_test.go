// The declarations that the workbench embeds are the copies of packages/workbench, which make exposure-check holds equal to their
// source (docs/spec/hosts.md#workbench).
package workbench_test

import (
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
