package workbench_test

import (
	"encoding/json"
	"strings"
	"testing"
)

// The account group of a plugin page draws the description that the rows section of workbench.json declares, and no login
// sentence (docs/spec/settings.md#plugins).
func TestTheAccountGroupDrawsTheDeclaredDescription(t *testing.T) {
	host := &accountsHost{runs: []accountAnswer{{stdout: loggedOut}}}
	f := accountsShell(t, host, []map[string]any{{"id": "account-1", "name": "업무", "kind": "claude"}})
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.shell.Registry().RunLater("core.settings-tab.plugin", json.RawMessage(`{"plugin":"agents"}`), func(any, error) {})
	f.settle()
	const description = "에이전트 CLI 계정."
	count := 0
	for _, text := range f.tester.Texts() {
		if strings.Contains(text, "시스템 브라우저") {
			t.Fatalf("the account group draws a login sentence: %q", text)
		}
		if text == description {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("the account description is drawn %d times; the texts are %q", count, f.tester.Texts())
	}
}
