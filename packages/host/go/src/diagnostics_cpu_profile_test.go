//go:build diagnostics

package host

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"
)

func runCPUProfile(t *testing.T, params string) (any, error) {
	t.Helper()
	method := diagnosticMethods["diagnostics.cpu.profile"]
	if method == nil {
		t.Fatal("diagnostics.cpu.profile is not registered")
	}
	return method(nil, nil, json.RawMessage(params), nil)
}

// contract: diagnostics.cpu-profile.profiles-until-stopped
func TestTheCPUProfileRequiresOn(t *testing.T) {
	_, err := runCPUProfile(t, `{}`)
	if err == nil || err.Error() != "-32602: on is required" {
		t.Fatalf("a request without on answered %v", err)
	}
}

// contract: diagnostics.cpu-profile.profiles-until-stopped
func TestTheCPUProfileStopAnswersThePathOfTheProfile(t *testing.T) {
	if reply, err := runCPUProfile(t, `{"on":false}`); reply != nil || err != nil {
		t.Fatalf("a stop while no profile runs answered %v, %v", reply, err)
	}
	folder := filepath.Join(t.TempDir(), "logs")
	if err := StartCPUProfile(folder); err != nil {
		t.Fatal(err)
	}
	reply, err := runCPUProfile(t, `{"on":false}`)
	if err != nil {
		t.Fatal(err)
	}
	path, _ := reply.(map[string]any)["path"].(string)
	if filepath.Dir(path) != folder {
		t.Fatalf("the stop answered %v, want the path of a profile in %s", reply, folder)
	}
	if again, err := runCPUProfile(t, `{"on":false}`); !reflect.DeepEqual(again, nil) || err != nil {
		t.Fatalf("a second stop answered %v, %v", again, err)
	}
}
