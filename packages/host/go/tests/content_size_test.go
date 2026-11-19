package host_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// TestTheContentSizeOfEachCase reads the params of each case of docs/spec/cases/window-resize.json as host.window.resize reads them.
// contract: exposure.window-resize.bound-and-text
func TestTheContentSizeOfEachCase(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "spec", "cases", "window-resize.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Name   string
			Params json.RawMessage
			Error  *string
		}
	}
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatal(err)
	}
	for _, c := range file.Cases {
		width, height, err := host.ContentSize(c.Params)
		if c.Error == nil {
			var want struct{ Width, Height float64 }
			if err := json.Unmarshal(c.Params, &want); err != nil {
				t.Fatal(err)
			}
			if err != nil || width != want.Width || height != want.Height {
				t.Errorf("%s: read %v × %v with %v, want %v × %v", c.Name, width, height, err, want.Width, want.Height)
			}
			continue
		}
		var refusal *host.RPCError
		if !errors.As(err, &refusal) || refusal.Code != -32602 || refusal.Message != *c.Error {
			t.Errorf("%s: refused with %v, want -32602 %q", c.Name, err, *c.Error)
		}
	}
}
