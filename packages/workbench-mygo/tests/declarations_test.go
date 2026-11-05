// The declarations that the workbench embeds are the copies of packages/workbench, which make exposure-check holds equal to their
// source (docs/spec/hosts.md#workbench).
package workbench_test

import (
	"runtime"
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
