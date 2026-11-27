package host

import (
	"reflect"
	"testing"
	"unsafe"
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

// A main page reload ends the view documents, and the view that the reloaded page creates receives the theme of the window, the same
// values as before the reload, in its first script.
// contract: view.theme.first-script
func TestAViewCreatedAfterAReloadReceivesTheCurrentTheme(t *testing.T) {
	theme := Theme{Scheme: "dark", Tokens: map[string]string{"surface": "#101010"}}
	probe := newViewProbe(t, theme)
	if err := probe.attach(t, nullOriginStart(), "ui/page.html"); err != nil {
		t.Fatalf("attach the view before the reload: %v", err)
	}
	before := probe.waitCall(t, "probe.opened")["theme"]

	s := probe.s
	s.host.relay = &Relay[relayTarget]{waiting: map[uint64]*relayWaiter[relayTarget]{}}
	s.reloadCancelLayout = func() error { return nil }
	s.reloadKeysPageEnded = func() {}
	s.reloadHideSurface = func(unsafe.Pointer, bool) {}
	s.reloadCloseImage = func(unsafe.Pointer) {}
	probe.main(func() {
		if _, err := s.reloadSurfaceDocuments(); err != nil {
			t.Errorf("reload the surface documents: %v", err)
		}
	})

	if err := probe.attach(t, nullOriginStart(), "ui/page.html"); err != nil {
		t.Fatalf("attach the view after the reload: %v", err)
	}
	opened := 0
	probe.wait(t, "the second view call probe.opened", func(event hostEvent) bool {
		data, _ := event.data.(map[string]any)
		if event.name == "view-call" && data["command"] == "probe.opened" {
			opened++
		}
		return opened == 2
	})
	after := probe.waitCall(t, "probe.opened")["theme"]
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("the view after the reload read the theme %v, want the theme before the reload %v", after, before)
	}
}
