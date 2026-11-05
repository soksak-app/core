package workbench_test

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTheSizeCommandSetsACardOnAnAxis(t *testing.T) {
	f, left, right := splitShell(t)
	before := f.box("core.card", left)
	f.run("core.grid.size", map[string]any{"card": left, "axis": "x", "size": 300})
	f.settle()
	if got := f.box("core.card", left); got.W == before.W || got.W != 300 {
		t.Fatalf("the card stands at %v after %v", got, before)
	}
	if got := f.box("core.card", right); got.X < 300 {
		t.Fatalf("the other card stands at %v", got)
	}
	for _, refused := range []map[string]any{
		{"card": left, "axis": "z", "size": 300},
		{"card": "absent", "axis": "x", "size": 300},
		{"card": left, "axis": "x", "size": -1},
	} {
		_, err := f.answer("core.grid.size", refused)
		if err == nil || !strings.Contains(err.Error(), "cannot size "+refused["card"].(string)+" on "+refused["axis"].(string)) {
			t.Fatalf("%v answered %v", refused, err)
		}
	}
}

func TestTheFolderCommandCreatesThroughTheHost(t *testing.T) {
	f := newShell(t, &storedHost{})
	var made any
	f.shell.Registry().RunLater("core.folder.create", json.RawMessage(`{"parent":"/work","name":"gamma"}`), func(value any, err error) {
		if err != nil {
			t.Error(err)
		}
		made = value
	})
	f.settle()
	encoded, err := json.Marshal(made)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(encoded), `{"identity":"identity of /work/gamma","root":"/work/gamma"}`; got != want {
		t.Fatalf("the command answered %s", got)
	}
	if !f.host.called("projectCreate") {
		t.Fatal("the host was not asked")
	}
}
