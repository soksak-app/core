package host

// The plugin host web views of a window against a fake platform (docs/spec/plugin-host.md).

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// hostViewPlatform is the platform of the plugin host tests. It records the host web views that are created with their
// configuration, the addresses that they load, the scripts that are added, and the web views that are closed. Every
// other operation of the platform interface is not implemented by it.
type hostViewPlatform struct {
	platform.Platform
	created []hostViewCreation
	loaded  []string
	scripts []string
	closed  []unsafe.Pointer
	refuse  bool
}

type hostViewCreation struct {
	window                             uintptr
	directory, folder, plugin, channel string
}

func (p *hostViewPlatform) CreatePluginHost(window unsafe.Pointer, directory, folder, plugin, channel string, changed func(state string)) (unsafe.Pointer, error) {
	if p.refuse {
		return nil, errors.New("no window")
	}
	p.created = append(p.created, hostViewCreation{window: uintptr(window), directory: directory, folder: folder, plugin: plugin, channel: channel})
	return unsafe.Pointer(new(int)), nil
}

func (p *hostViewPlatform) SetViewMessage(unsafe.Pointer, func(string)) error { return nil }

func (p *hostViewPlatform) SetViewEnded(unsafe.Pointer, func()) error { return nil }

func (p *hostViewPlatform) AddDocumentScript(document unsafe.Pointer, source string) error {
	p.scripts = append(p.scripts, source)
	return nil
}

func (p *hostViewPlatform) LoadDocument(document unsafe.Pointer, url string) bool {
	if p.refuse {
		return false
	}
	p.loaded = append(p.loaded, url)
	return true
}

func (p *hostViewPlatform) CloseDocument(document unsafe.Pointer) {
	p.closed = append(p.closed, document)
}

// hostFixture installs one enabled plugin probe, whose manifest declares host, and one enabled plugin plain, whose
// manifest declares none. It returns the configuration folder.
func hostFixture(t *testing.T) string {
	t.Helper()
	config := t.TempDir()
	folder := filepath.Join(config, "plugins", "probe", "0.1.0")
	if err := os.MkdirAll(filepath.Join(folder, "ui"), 0o755); err != nil {
		t.Fatal(err)
	}
	installed := `{"format":3,"plugins":{"probe":{"enabled":true,"path":"plugins/probe/0.1.0","sidecars":{},"version":"0.1.0"},"plain":{"enabled":true,"path":"plugins/plain/0.1.0","sidecars":{},"version":"0.1.0"}},"sidecars":{}}`
	if err := os.WriteFile(filepath.Join(config, "plugins", "installed.json"), []byte(installed), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "plugin.json"), []byte(`{"id":"probe","host":{"page":"ui/host.html"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "package.json"), []byte(`{"name":"probe"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	plain := filepath.Join(config, "plugins", "plain", "0.1.0")
	if err := os.MkdirAll(plain, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plain, "plugin.json"), []byte(`{"id":"plain"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plain, "package.json"), []byte(`{"name":"plain"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return config
}

func hostTestSurfaces(config string) *Surfaces {
	return &Surfaces{host: &Host{configDir: config}, pluginHosts: map[string]unsafe.Pointer{}}
}

// contract: plugin-host.create-loads-page
func TestPluginHostPageReadyCreatesHiddenHostAndLoadsPage(t *testing.T) {
	config := hostFixture(t)
	fake := &hostViewPlatform{}
	saved := system
	system = fake
	savedScript := viewChannelScript
	viewChannelScript = "channel-script"
	t.Cleanup(func() { system = saved; viewChannelScript = savedScript })
	plugins, err := hostPlugins(config)
	if err != nil {
		t.Fatalf("host plugins: %v", err)
	}
	if len(plugins) != 1 || plugins[0].id != "probe" || plugins[0].page != "ui/host.html" {
		t.Fatalf("host plugins: %+v, want only probe with ui/host.html", plugins)
	}
	s := hostTestSurfaces(config)
	s.createPluginHosts(unsafe.Pointer(new(int)), plugins)
	if len(fake.created) != 1 {
		t.Fatalf("created host web views: %+v, want one", fake.created)
	}
	created := fake.created[0]
	if created.plugin != "probe" || created.channel == "" || created.folder == "" || created.directory == "" {
		t.Fatalf("created host web view: %+v, want the view configuration of probe in its folder and data directory with the channel script", created)
	}
	if want := []string{"sok://probe/ui/host.html"}; len(fake.loaded) != 1 || fake.loaded[0] != want[0] {
		t.Fatalf("loaded addresses: %v, want %v", fake.loaded, want)
	}
	if len(fake.scripts) != 1 {
		t.Fatalf("added scripts: %v, want the theme script of the configuration", fake.scripts)
	}
	if _, ok := s.pluginHosts["probe"]; !ok {
		t.Fatalf("the host web view of probe is not recorded")
	}
}

// contract: plugin-host.create-once-per-plugin
func TestPluginHostPageReadyCreatesOneHostPerPlugin(t *testing.T) {
	config := hostFixture(t)
	fake := &hostViewPlatform{}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	plugins, err := hostPlugins(config)
	if err != nil {
		t.Fatalf("host plugins: %v", err)
	}
	s := hostTestSurfaces(config)
	s.createPluginHosts(nil, plugins)
	s.createPluginHosts(nil, plugins)
	if len(fake.created) != 1 {
		t.Fatalf("created host web views after a second readiness: %d, want one per plugin per window", len(fake.created))
	}
}

// contract: plugin-host.change-disposes
func TestPluginHostRemoveDisposesTheHostOfThePlugin(t *testing.T) {
	config := hostFixture(t)
	fake := &hostViewPlatform{}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	plugins, err := hostPlugins(config)
	if err != nil {
		t.Fatalf("host plugins: %v", err)
	}
	s := hostTestSurfaces(config)
	s.createPluginHosts(nil, plugins)
	s.disposePluginHost("probe")
	if len(fake.closed) != 1 {
		t.Fatalf("closed host web views after the removal: %d, want one", len(fake.closed))
	}
	if _, ok := s.pluginHosts["probe"]; ok {
		t.Fatalf("the host web view of probe is recorded after its removal")
	}
	// The disposal of a plugin that has no host web view closes nothing.
	s.disposePluginHost("plain")
	if len(fake.closed) != 1 {
		t.Fatalf("closed host web views after the disposal of plain: %d, want one", len(fake.closed))
	}
}

// contract: plugin-host.reload-disposes
func TestPluginHostReloadDisposesEveryHost(t *testing.T) {
	config := hostFixture(t)
	fake := &hostViewPlatform{}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	plugins, err := hostPlugins(config)
	if err != nil {
		t.Fatalf("host plugins: %v", err)
	}
	s := hostTestSurfaces(config)
	s.createPluginHosts(nil, plugins)
	s.disposePluginHosts()
	if len(fake.closed) != 1 {
		t.Fatalf("closed host web views after the reload: %d, want one", len(fake.closed))
	}
	if len(s.pluginHosts) != 0 {
		t.Fatalf("host web views after the reload: %d, want none", len(s.pluginHosts))
	}
	// The next readiness creates the host web views again.
	s.createPluginHosts(nil, plugins)
	if len(fake.created) != 2 {
		t.Fatalf("created host web views after the reload and the next readiness: %d, want two", len(fake.created))
	}
}

// contract: plugin-host.close-disposes
func TestPluginHostCloseDisposesEveryHost(t *testing.T) {
	config := hostFixture(t)
	fake := &hostViewPlatform{}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	plugins, err := hostPlugins(config)
	if err != nil {
		t.Fatalf("host plugins: %v", err)
	}
	s := hostTestSurfaces(config)
	s.createPluginHosts(nil, plugins)
	s.disposePluginHosts()
	if len(fake.closed) != 1 {
		t.Fatalf("closed host web views after the window close: %d, want one", len(fake.closed))
	}
}

// contract: plugin-host.declaration-requires-page
func TestPluginHostDeclarationWithoutPageIsAnError(t *testing.T) {
	if _, err := hostPage("probe", []byte(`{"host":"ui/host.html"}`)); err == nil || err.Error() != "plugin probe declares host that is not an object" {
		t.Fatalf("host as a string: err %v, want plugin probe declares host that is not an object", err)
	}
	if _, err := hostPage("probe", []byte(`{"host":{}}`)); err == nil || err.Error() != "plugin probe declares host without a page" {
		t.Fatalf("host without a page: err %v, want plugin probe declares host without a page", err)
	}
	if _, err := hostPage("probe", []byte(`{"host":{"page":5}}`)); err == nil || err.Error() != "plugin probe declares host without a page" {
		t.Fatalf("host whose page is not a string: err %v, want plugin probe declares host without a page", err)
	}
	page, err := hostPage("probe", []byte(`{"host":{"page":"ui/host.html"}}`))
	if err != nil || page != "ui/host.html" {
		t.Fatalf("host with a page: page %q, err %v", page, err)
	}
	if page, err := hostPage("probe", []byte(`{"id":"probe"}`)); page != "" || err != nil {
		t.Fatalf("manifest without host: page %q, err %v", page, err)
	}
}
