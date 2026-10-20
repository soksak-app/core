package host

import (
	"testing"
	"unsafe"
)

// contract: view.theme.first-script
// A view that the host creates receives, before its page loads, the document-start script that sets window.sokTheme to the frozen theme
// current at creation, so the first page script reads the tokens.
func TestViewCreationAddsTheThemeScriptBeforeTheLoad(t *testing.T) {
	clock := &fakeClock{}
	fake := &lifecyclePlatform{ended: map[unsafe.Pointer]func(){}, responsiveness: map[unsafe.Pointer]func(bool){}, scripts: map[unsafe.Pointer][]string{}}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{
		documents: NewDocuments(),
		lifecycle: newViewLifecycle(clock.now),
		host:      &Host{configDir: "/config"},
		theme:     Theme{Scheme: "dark", Tokens: map[string]string{"surface": "#101010"}},
	}
	native := unsafe.Pointer(new(int))
	spec := s.viewRecords().track("probe-surface", native, "probe", "ui/page.html", true)
	spec.directory, spec.folder = "/config/document-data", "/plugins/probe"
	if err := s.syncView("probe-surface", native, "probe", "ui/page.html", true); err != nil {
		t.Fatalf("first sync of the view: %v", err)
	}
	if len(fake.created) != 1 {
		t.Fatalf("views created: %d, want one", len(fake.created))
	}
	want := `window.sokTheme = Object.freeze({"scheme":"dark","tokens":{"surface":"#101010"}});`
	scripts := fake.scripts[fake.created[0]]
	if len(scripts) != 1 || scripts[0] != want {
		t.Fatalf("user scripts of the view: %q, want the theme script %q", scripts, want)
	}
	if len(fake.loadsBeforeScript) != 1 || fake.loadsBeforeScript[0] != 0 {
		t.Fatalf("loads before the theme script: %v, want none", fake.loadsBeforeScript)
	}
}

// The theme script is the frozen value of the theme, as JSON.
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
