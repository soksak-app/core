package sok

import (
	"strings"
	"testing"
)

// programsManifest is a valid view plugin whose programs member holds one entry with the given pattern.
func programsManifest(pattern string) map[string]any {
	return map[string]any{
		"id":          "probe",
		"name":        "Probe",
		"description": "Sample.",
		"surface":     map[string]any{"composition": map[string]any{"kind": "view", "page": "ui/page.html"}},
		"mark":        "P",
		"icon":        "<svg></svg>",
		"programs": map[string]any{
			"run": map[string]any{"program": "git", "args": []any{map[string]any{"pattern": pattern}}},
		},
	}
}

// contract: install.plugin-program-pattern
// A pattern that the RE2 library does not compile is refused at install with its name and the reason (docs/spec/plugins.md#pluginjson).
func TestProgramPatternThatDoesNotCompileIsRefused(t *testing.T) {
	err := ValidateManifest(programsManifest("("))
	if err == nil {
		t.Fatal("a pattern that does not compile was accepted")
	}
	if !strings.HasPrefix(err.Error(), "plugin probe: programs.run pattern does not compile: ") {
		t.Fatalf("error = %q", err.Error())
	}
}

// contract: install.plugin-program-pattern
// A pattern that compiles is accepted.
func TestProgramPatternThatCompilesIsAccepted(t *testing.T) {
	if err := ValidateManifest(programsManifest("[a-z]+")); err != nil {
		t.Fatalf("a compiling pattern was refused: %v", err)
	}
}
