package host_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// TestTheHostRefusesTheParamsOfEachCase runs each case of docs/spec/cases/command-params.json through the check that the endpoint
// of the host and the registry of the mygo workbench refuse a command with.
// contract: exposure.command-params.checked-before-the-run
func TestTheHostRefusesTheParamsOfEachCase(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "spec", "cases", "command-params.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Name, Command string
			Schema        any
			Params        json.RawMessage
			Error         *string
		}
	}
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) < 8 {
		t.Fatalf("command-params.json holds %d cases, fewer than eight", len(file.Cases))
	}
	for _, c := range file.Cases {
		want := ""
		if c.Error != nil {
			want = *c.Error
		}
		if got := host.CommandParamsRefusal(c.Command, c.Schema, c.Params); got != want {
			t.Errorf("%s: refused with %q, want %q", c.Name, got, want)
		}
	}
}
