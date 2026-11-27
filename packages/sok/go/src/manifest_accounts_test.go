package sok

import "testing"

// accountsManifest is a valid view plugin that declares accounts whose three programs run the program run.
func accountsManifest() map[string]any {
	return map[string]any{
		"id":          "probe",
		"name":        "Probe",
		"description": "Sample.",
		"surface":     map[string]any{"composition": map[string]any{"kind": "view", "page": "ui/page.html"}},
		"mark":        "P",
		"icon":        "<svg></svg>",
		"programs": map[string]any{
			"run": map[string]any{"program": "git", "args": []any{map[string]any{"pattern": "[a-z]+"}, map[string]any{"pattern": "[a-z]+"}}},
		},
		"accounts": map[string]any{
			"kinds":    []any{map[string]any{"value": "claude", "label": "Claude"}},
			"programs": map[string]any{"status": "run", "login": "run", "logout": "run"},
		},
	}
}

// contract: install.plugin-accounts
// Accounts whose programs name a declaration that the manifest lacks are refused with the reason that the programs declaration is missing.
func TestAccountsWithoutAProgramsDeclarationAreRefused(t *testing.T) {
	manifest := accountsManifest()
	delete(manifest, "programs")
	err := ValidateManifest(manifest)
	if err == nil {
		t.Fatal("accounts without a programs declaration were accepted")
	}
	if want := "plugin probe: accounts need a programs declaration"; err.Error() != want {
		t.Fatalf("error = %q, want %q", err.Error(), want)
	}
}
