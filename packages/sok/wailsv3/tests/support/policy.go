package support

// Shared precondition of the tests of the tool's events (docs/spec/logging.md#policy-file).

import (
	"os"
	"path/filepath"
	"testing"
)

// StoreEveryLevel writes the policy file of the configuration directory that stores every level of every class. The default policy
// stores only errors, so a test that checks an event below error gives the tool this file before the tool starts; the tool applies
// the file once at its start and records the policy with the event `log.policy`.
func StoreEveryLevel(t *testing.T, config string) {
	t.Helper()
	text := `{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`
	if err := os.WriteFile(filepath.Join(config, "log-policy.json"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}
