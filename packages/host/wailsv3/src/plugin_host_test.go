package host

// The plugin host web views of a window against a fake platform (docs/spec/plugin-host.md).

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
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
	return &Surfaces{host: &Host{configDir: config}, pluginHosts: map[string]unsafe.Pointer{}, pluginHostChannels: newPluginHostChannels(), pluginHostRestarts: newPluginHostRestarts(), events: func(string, any) {}}
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
	if _, _, err := hostDeclaration("probe", []byte(`{"host":"ui/host.html"}`)); err == nil || err.Error() != "plugin probe declares host that is not an object" {
		t.Fatalf("host as a string: err %v, want plugin probe declares host that is not an object", err)
	}
	if _, _, err := hostDeclaration("probe", []byte(`{"host":{}}`)); err == nil || err.Error() != "plugin probe declares host without a page" {
		t.Fatalf("host without a page: err %v, want plugin probe declares host without a page", err)
	}
	if _, _, err := hostDeclaration("probe", []byte(`{"host":{"page":5}}`)); err == nil || err.Error() != "plugin probe declares host without a page" {
		t.Fatalf("host whose page is not a string: err %v, want plugin probe declares host without a page", err)
	}
	page, state, err := hostDeclaration("probe", []byte(`{"host":{"page":"ui/host.html"}}`))
	if err != nil || page != "ui/host.html" || state != nil {
		t.Fatalf("host with a page: page %q, state %v, err %v", page, state, err)
	}
	if page, _, err := hostDeclaration("probe", []byte(`{"id":"probe"}`)); page != "" || err != nil {
		t.Fatalf("manifest without host: page %q, err %v", page, err)
	}
}

// contract: plugin-host.state.declaration
func TestPluginHostStateDeclarationNeedsFormatAndMaxBytes(t *testing.T) {
	page, state, err := hostDeclaration("probe", []byte(`{"host":{"page":"ui/host.html","state":{"format":2,"maxBytes":65536}}}`))
	if err != nil || page != "ui/host.html" || state == nil || *state != (hostState{format: 2, maxBytes: 65536}) {
		t.Fatalf("host with a state: page %q, state %v, err %v", page, state, err)
	}
	want := "plugin probe declares host state that is not {format, maxBytes} with positive integers"
	for _, declared := range []string{
		`null`, `1`, `{}`, `{"format":1}`, `{"maxBytes":1}`, `{"format":0,"maxBytes":1}`, `{"format":1,"maxBytes":-1}`,
		`{"format":1.5,"maxBytes":1}`, `{"format":"1","maxBytes":1}`, `{"format":1,"maxBytes":1,"other":1}`,
	} {
		manifest := `{"host":{"page":"ui/host.html","state":` + declared + `}}`
		if _, _, err := hostDeclaration("probe", []byte(manifest)); err == nil || err.Error() != want {
			t.Fatalf("state %s: err %v, want %s", declared, err, want)
		}
	}
}

// restartWindows returns two windows of one host over the configuration folder config, which share the restart-limit
// records and the saved states of the plugin hosts, and the clock offset that the restart limit reads. Each window has
// the host web view of probe created through fake.
func restartWindows(t *testing.T, config string, fake *hostViewPlatform) ([2]*Surfaces, *time.Duration) {
	t.Helper()
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	offset := new(time.Duration)
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	restarts := newPluginHostRestarts()
	restarts.Now = func() time.Time { return start.Add(*offset) }
	host := &Host{configDir: config, windows: map[uint]*Surfaces{}, pluginHostStates: newPluginHostStates(), pluginHostRestarts: restarts}
	var windows [2]*Surfaces
	plugins, err := hostPlugins(config)
	if err != nil {
		t.Fatalf("host plugins: %v", err)
	}
	for index := range windows {
		window := &Surfaces{host: host, pluginHosts: map[string]unsafe.Pointer{}, pluginHostChannels: newPluginHostChannels(),
			pluginHostStates: host.pluginHostStates, pluginHostRestarts: restarts, events: func(string, any) {}}
		host.windows[uint(index+1)] = window
		window.createPluginHosts(nil, plugins)
		windows[index] = window
	}
	return windows, offset
}

// failHost ends the page process of the current host web view of probe in window at the clock offset at.
func failHost(t *testing.T, window *Surfaces, offset *time.Duration, at time.Duration) {
	t.Helper()
	*offset = at
	handle, ok := window.pluginHosts["probe"]
	if !ok {
		t.Fatalf("the window has no host web view of probe to end at %v", at)
	}
	window.pluginHostEnded("probe", handle)
}

// contract: plugin-host.restart.failure-restarts
func TestPluginHostRestartCreatesTheHostAgainAfterAFailure(t *testing.T) {
	fake := &hostViewPlatform{}
	windows, offset := restartWindows(t, hostFixture(t), fake)
	first := windows[0].pluginHosts["probe"]
	failHost(t, windows[0], offset, 0)
	if len(fake.closed) != 1 || len(fake.created) != 3 {
		t.Fatalf("the process end closed %d and created %d host web views, want 1 closed and 3 created", len(fake.closed), len(fake.created))
	}
	if handle, ok := windows[0].pluginHosts["probe"]; !ok || handle == first {
		t.Fatalf("the window holds no new host web view of probe after the failure")
	}
	// The queue overflow of the channel is a failure too.
	windows[0].pluginHostReceived("probe", hostMessage(`{"event": "view.error", "reason": "queue full for probe"}`))
	if len(fake.closed) != 2 || len(fake.created) != 4 {
		t.Fatalf("the overflow closed %d and created %d host web views, want 2 closed and 4 created", len(fake.closed), len(fake.created))
	}
	if attempts := windows[0].pluginHostRestarts.byPlugin["probe"].attempts; attempts != 2 {
		t.Fatalf("restart attempts %d, want 2", attempts)
	}
	// A failure 300 seconds or less before the new one is counted, and an older one is not.
	failHost(t, windows[0], offset, 400*time.Second)
	failHost(t, windows[0], offset, 500*time.Second)
	if len(fake.created) != 6 || windows[0].pluginHostRestarts.stopped("probe") {
		t.Fatalf("the fourth failure with the first two outside 300 s created %d host web views, stopped %v; want 6 and running",
			len(fake.created), windows[0].pluginHostRestarts.stopped("probe"))
	}
}

// contract: plugin-host.restart.fourth-failure-stops
func TestPluginHostRestartStopsAtTheFourthFailureInEveryWindow(t *testing.T) {
	fake := &hostViewPlatform{}
	config := hostFixture(t)
	windows, offset := restartWindows(t, config, fake)
	failHost(t, windows[0], offset, 0)
	failHost(t, windows[0], offset, 10*time.Second)
	failHost(t, windows[1], offset, 20*time.Second)
	created := len(fake.created)
	// The fourth failure within 300 seconds, counted over both windows, stops the host of probe in every window.
	failHost(t, windows[0], offset, 30*time.Second)
	if len(fake.created) != created {
		t.Fatalf("the fourth failure created %d host web views", len(fake.created)-created)
	}
	for index, window := range windows {
		if _, ok := window.pluginHosts["probe"]; ok {
			t.Fatalf("window %d holds the host web view of probe after the stop", index+1)
		}
	}
	if !windows[1].pluginHostRestarts.stopped("probe") {
		t.Fatalf("the restarts of probe are not stopped")
	}
	// A readiness of the page creates no host of the stopped plugin.
	plugins, err := hostPlugins(config)
	if err != nil {
		t.Fatalf("host plugins: %v", err)
	}
	windows[1].createPluginHosts(nil, plugins)
	if len(fake.created) != created {
		t.Fatalf("a page readiness created the host of a stopped plugin")
	}
}

// contract: plugin-host.restart.surface-open-resets
func TestPluginHostRestartResetsOnTheOpenOfASurfaceOfThePlugin(t *testing.T) {
	fake := &hostViewPlatform{}
	windows, offset := restartWindows(t, hostFixture(t), fake)
	run := func(f func()) { f() }
	// The open of a surface while the host runs clears nothing and creates nothing.
	failHost(t, windows[0], offset, 0)
	created := len(fake.created)
	windows[0].pluginHostReset("probe", run)
	if len(fake.created) != created || windows[0].pluginHostRestarts.byPlugin["probe"] == nil {
		t.Fatalf("the open of a surface of a running host created %d host web views or cleared its record", len(fake.created)-created)
	}
	for at := 10; at <= 30; at += 10 {
		failHost(t, windows[0], offset, time.Duration(at)*time.Second)
	}
	created = len(fake.created)
	// The open of a surface of another plugin clears nothing.
	windows[1].pluginHostReset("plain", run)
	if !windows[1].pluginHostRestarts.stopped("probe") || len(fake.created) != created {
		t.Fatalf("the open of a surface of another plugin cleared the stop of probe")
	}
	windows[1].pluginHostReset("probe", run)
	if windows[1].pluginHostRestarts.stopped("probe") || windows[1].pluginHostRestarts.byPlugin["probe"] != nil {
		t.Fatalf("the open of a surface of probe kept its record")
	}
	if len(fake.created) != created+2 {
		t.Fatalf("the reset created %d host web views, want one in each window", len(fake.created)-created)
	}
	for index, window := range windows {
		if _, ok := window.pluginHosts["probe"]; !ok {
			t.Fatalf("window %d holds no host web view of probe after the reset", index+1)
		}
	}
}

// The creation of a plugin host keeps the restart stop of each sidecar that its plugin lists: only the open of a surface or the enable of
// the plugin clears a stop (docs/spec/plugin-host.md#restarts, docs/spec/sidecars.md#failure).
// contract: plugin-host.sidecar.stop-kept
func TestPluginHostCreationKeepsTheSidecarStopOfItsPlugin(t *testing.T) {
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
	s := hostTestSurfaces(config)
	c := sidecarSessionSurfaces(t).sidecars
	s.sidecars = c
	stopFixtureSidecar(c)
	s.createPluginHosts(unsafe.Pointer(new(int)), plugins)
	if len(fake.created) != 1 {
		t.Fatalf("created host web views: %+v, want one", fake.created)
	}
	c.mu.Lock()
	stopped := c.restartStopped("fixture-sidecar")
	c.mu.Unlock()
	if !stopped {
		t.Fatal("the creation of the plugin host cleared the sidecar stop of its plugin")
	}
}

// A view.error without a reason is refused with an error that names the plugin. An empty reason would give an error with no text.
// contract: plugin-host.channel.view-error-without-reason-is-refused
func TestViewErrorWithoutAReasonIsRefused(t *testing.T) {
	windows, _ := restartWindows(t, hostFixture(t), &hostViewPlatform{})
	err := windows[0].pluginHostMessage("probe", hostMessage(`{"event": "view.error"}`))
	if err == nil || err.Error() != "plugin probe: view.error has no reason" {
		t.Fatalf("view.error without a reason gave %v, want the refusal that names the plugin", err)
	}
}
