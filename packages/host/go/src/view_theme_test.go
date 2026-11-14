package host

import (
	"reflect"
	"testing"
)

// A view that the host creates receives, before its page loads, the document-start script that sets window.sokTheme to the frozen theme
// current at creation, so the first page script reads the tokens. The page of a real view reports what its first script reads.
// contract: view.theme.first-script
func TestViewCreationAddsTheThemeScriptBeforeTheLoad(t *testing.T) {
	theme := Theme{Scheme: "dark", Tokens: map[string]string{"surface": "#101010"}}
	opened := realViewProbe(t, theme, nullOriginStart()).waitCall(t, "probe.opened")
	want := map[string]any{"scheme": "dark", "tokens": map[string]any{"surface": "#101010"}}
	if !reflect.DeepEqual(opened["theme"], want) {
		t.Fatalf("the first script of the page read the theme %v, want %v", opened["theme"], want)
	}
}

// The theme script is the frozen value of the theme, as JSON.
// contract: view.theme.first-script
func TestThemeScriptFreezesTheThemeValue(t *testing.T) {
	theme := Theme{Scheme: "dark", Tokens: map[string]string{"surface": "#101010"}}
	want := `window.sokTheme = Object.freeze({"scheme":"dark","tokens":{"surface":"#101010"}});`
	got, err := themeScript(theme)
	if err != nil {
		t.Fatalf("theme script: %v", err)
	}
	if got != want {
		t.Fatalf("theme script %q, want %q", got, want)
	}
}
