package host_test

// 설정 폴더에 설치된 plugin 의 제공과 그 sidecar 찾기(docs/spec/installation.md 의 설치된 plugin 제공)를 검사한다.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// writeInstalled 는 경로마다 내용을 설정 폴더에 쓴다.
func writeInstalled(t *testing.T, config string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		file := filepath.Join(config, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// installedFixture 는 켜진 plugin 둘과 꺼진 plugin 하나, 그리고 sidecar 하나를 설치한 설정 폴더다.
func installedFixture(t *testing.T) string {
	config := t.TempDir()
	writeInstalled(t, config, map[string]string{
		"plugins/installed.json": `{"format": 2, "plugins": {
			"term": {"package": "@scope/plugin-term", "version": "0.1.0", "path": "plugins/term/0.1.0", "enabled": true, "sidecars": {"@scope/sidecar-worker": "^0.1.0"}},
			"alpha": {"package": "plugin-alpha", "version": "1.0.0", "path": "plugins/alpha/1.0.0", "enabled": true, "sidecars": {}},
			"off": {"package": "plugin-off", "version": "1.0.0", "path": "plugins/off/1.0.0", "enabled": false, "sidecars": {}}},
			"sidecars": {"@scope/sidecar-worker": {"version": "0.1.2", "path": "sidecars/scope-sidecar-worker/0.1.2/darwin-arm64"}}}`,
		"plugins/term/0.1.0/plugin.json":                                `{"id": "term", "dependencies": {"@scope/sidecar-worker": "^0.1.0"}}`,
		"plugins/term/0.1.0/ui/term.js":                                 "export const term = 1;",
		"plugins/term/0.1.0/diagnostics.json":                           "{\n  \"module\": \"ui/d.js\",\n  \"exposes\": {}\n}\n",
		"plugins/alpha/1.0.0/plugin.json":                               `{"id": "alpha"}`,
		"plugins/off/1.0.0/plugin.json":                                 `{"id": "off"}`,
		"sidecars/scope-sidecar-worker/0.1.2/darwin-arm64/sidecar.json": `{"executable": "build/worker", "protocol": 1}`,
	})
	return config
}

// contract: installed.document.lists-enabled-plugins
func TestInstalledPluginsDocumentListsEnabledPluginsById(t *testing.T) {
	config := installedFixture(t)
	release := `{"plugins":[{"id":"alpha","package":"plugin-alpha","version":"1.0.0","manifest":{"id":"alpha"}},{"id":"term","package":"@scope/plugin-term","version":"0.1.0","manifest":{"id":"term","dependencies":{"@scope/sidecar-worker":"^0.1.0"}}}]}`
	if got := string(host.InstalledPluginsDocument(config, false)); got != release {
		t.Fatalf("release document %s", got)
	}
	diagnostic := `{"plugins":[{"id":"alpha","package":"plugin-alpha","version":"1.0.0","manifest":{"id":"alpha"}},{"id":"term","package":"@scope/plugin-term","version":"0.1.0","manifest":{"id":"term","dependencies":{"@scope/sidecar-worker":"^0.1.0"}},"diagnostics":{"module":"ui/d.js","exposes":{}}}]}`
	if got := string(host.InstalledPluginsDocument(config, true)); got != diagnostic {
		t.Fatalf("diagnostic document %s", got)
	}
	if got := string(host.InstalledPluginsDocument(t.TempDir(), true)); got != `{"plugins":[]}` {
		t.Fatalf("empty document %s", got)
	}
}

// contract: installed.document.reports-errors
func TestInstalledPluginsDocumentReportsAnInvalidState(t *testing.T) {
	config := installedFixture(t)
	writeInstalled(t, config, map[string]string{"plugins/term/0.1.0/diagnostics.json": "{"})
	if got := string(host.InstalledPluginsDocument(config, true)); got != `{"error":"`+filepath.Join(config, "plugins/term/0.1.0/diagnostics.json")+` is not valid JSON"}` {
		t.Fatalf("diagnostics error %s", got)
	}
	writeInstalled(t, config, map[string]string{"plugins/term/0.1.0/diagnostics.json": "{}", "plugins/alpha/1.0.0/plugin.json": "{"})
	if got := string(host.InstalledPluginsDocument(config, false)); got != `{"error":"`+filepath.Join(config, "plugins/alpha/1.0.0/plugin.json")+` is not valid JSON"}` {
		t.Fatalf("manifest error %s", got)
	}
	if err := os.Remove(filepath.Join(config, "plugins/alpha/1.0.0/plugin.json")); err != nil {
		t.Fatal(err)
	}
	if got := string(host.InstalledPluginsDocument(config, false)); got != `{"error":"`+filepath.Join(config, "plugins/alpha/1.0.0/plugin.json")+`: the plugin manifest is missing"}` {
		t.Fatalf("missing manifest %s", got)
	}
	writeInstalled(t, config, map[string]string{"plugins/installed.json": `{"format": 3, "plugins": {}, "sidecars": {}}`})
	if got := string(host.InstalledPluginsDocument(config, false)); got != `{"error":"`+filepath.Join(config, "plugins/installed.json")+`: plugins/installed.json: format must be 2"}` {
		t.Fatalf("state error %s", got)
	}
}

// contract: installed.modules.serve-installed-files
func TestInstalledAssetsServeTheFilesOfEnabledPackages(t *testing.T) {
	config := installedFixture(t)
	frontend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "frontend "+r.URL.Path) })
	handler := host.InstalledAssets(config)(frontend)
	get := func(path string) (int, string, string) {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		return recorder.Code, recorder.Body.String(), recorder.Header().Get("Content-Type")
	}
	if code, body, kind := get("/modules/@scope/plugin-term/ui/term.js"); code != 200 || body != "export const term = 1;" || kind != "text/javascript" {
		t.Fatalf("installed module %d %q %q", code, body, kind)
	}
	for _, path := range []string{"/modules/@scope/plugin-term/ui/missing.js", "/modules/@scope/plugin-term/ui/../plugin.json", "/modules/plugin-alpha//plugin.json"} {
		if code, _, _ := get(path); code != 404 {
			t.Fatalf("%s answered %d", path, code)
		}
	}
	for _, path := range []string{"/modules/plugin-off/plugin.json", "/modules/soksak/dist/index.js", "/index.html"} {
		if code, body, _ := get(path); code != 200 || body != "frontend "+path {
			t.Fatalf("%s: %d %q", path, code, body)
		}
	}
	if code, body, kind := get(host.InstalledPluginsPath); code != 200 || !strings.HasPrefix(body, `{"plugins":[{"id":"alpha"`) || kind != "application/json" {
		t.Fatalf("installed document %d %q %q", code, body, kind)
	}
}

// sharedFixture is a configuration directory where the enabled plugin alpha declares the shared modules of the point
// language and the disabled plugin off declares a point of the same name.
func sharedFixture(t *testing.T) string {
	config := installedFixture(t)
	writeInstalled(t, config, map[string]string{
		"plugins/alpha/1.0.0/plugin.json": `{"id": "alpha", "extends": {"language": {"version": "1.0.0", "schema": {},
			"modules": {"@codemirror/state": "ui/state.js", "gone": "ui/gone.js", "outside": "../../term/0.1.0/ui/term.js"}}}}`,
		"plugins/alpha/1.0.0/ui/state.js": "export const state = 1;",
		"plugins/off/1.0.0/plugin.json":   `{"id": "off", "extends": {"language": {"version": "1.0.0", "schema": {}, "modules": {"x": "ui/x.js"}}}}`,
		"plugins/off/1.0.0/ui/x.js":       "export const x = 1;",
	})
	return config
}

// contract: installed.shared.serve-extension-point-modules
func TestInstalledAssetsServeTheSharedModulesOfExtensionPoints(t *testing.T) {
	config := sharedFixture(t)
	frontend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "frontend "+r.URL.Path) })
	handler := host.InstalledAssets(config)(frontend)
	get := func(path string) (int, string, string) {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		return recorder.Code, recorder.Body.String(), recorder.Header().Get("Content-Type")
	}
	if code, body, kind := get("/shared/alpha.language/@codemirror/state"); code != 200 || body != "export const state = 1;" || kind != "text/javascript" {
		t.Fatalf("shared module %d %q %q", code, body, kind)
	}
	// An undeclared point, an unmapped specifier, a missing file, a path outside the package and a disabled plugin are
	// not found.
	for _, path := range []string{"/shared/alpha.missing/@codemirror/state", "/shared/alpha.language/@codemirror/view", "/shared/alpha.language/gone",
		"/shared/alpha.language/outside", "/shared/off.language/x", "/shared/nobody.language/x", "/shared/alpha", "/shared/alpha.language/"} {
		if code, body, _ := get(path); code != 404 {
			t.Fatalf("%s answered %d %q", path, code, body)
		}
	}
	writeInstalled(t, config, map[string]string{"plugins/alpha/1.0.0/plugin.json": "{"})
	if code, body, _ := get("/shared/alpha.language/@codemirror/state"); code != 500 || !strings.Contains(body, filepath.Join(config, "plugins/alpha/1.0.0/plugin.json")) {
		t.Fatalf("invalid manifest %d %q", code, body)
	}
}

// contract: installed.sidecars.resolve-installed-folders, sidecars.declaration.fails-on-missing-sidecar-json
func TestInstalledSidecarsResolveTheInstalledVersionFolders(t *testing.T) {
	config := installedFixture(t)
	declarations, err := host.InstalledSidecars(config)
	if err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(config, "sidecars/scope-sidecar-worker/0.1.2/darwin-arm64")
	if len(declarations) != 1 || declarations[0].Name != "@scope/sidecar-worker" || declarations[0].Folder != folder ||
		string(declarations[0].Data) != `{"executable": "build/worker", "protocol": 1}` {
		t.Fatalf("declarations %+v", declarations)
	}
	if err := os.Remove(filepath.Join(folder, "sidecar.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := host.InstalledSidecars(config); err == nil || !strings.Contains(err.Error(), filepath.Join(folder, "sidecar.json")) {
		t.Fatalf("missing sidecar.json: %v", err)
	}
	writeInstalled(t, config, map[string]string{"plugins/term/0.1.0/plugin.json": `{"id": "term", "dependencies": {"@scope/sidecar-other": "^0.1.0"}}`})
	if _, err := host.InstalledSidecars(config); err == nil || !strings.Contains(err.Error(), "sidecar @scope/sidecar-other has no installed version") {
		t.Fatalf("unknown sidecar: %v", err)
	}
	if declarations, err := host.InstalledSidecars(t.TempDir()); err != nil || len(declarations) != 0 {
		t.Fatalf("empty configuration %v %v", declarations, err)
	}
}

// contract: installed.sidecars.leave-out-plugin-packages
func TestInstalledSidecarsLeaveOutThePackagesOfInstalledPlugins(t *testing.T) {
	config := installedFixture(t)
	// The packages of an enabled and a disabled plugin are plugin dependencies, not sidecars.
	writeInstalled(t, config, map[string]string{
		"plugins/term/0.1.0/plugin.json": `{"id": "term", "dependencies": {"@scope/sidecar-worker": "^0.1.0", "plugin-alpha": "^1.0.0", "plugin-off": "^1.0.0"}}`,
	})
	declarations, err := host.InstalledSidecars(config)
	if err != nil {
		t.Fatal(err)
	}
	if len(declarations) != 1 || declarations[0].Name != "@scope/sidecar-worker" {
		t.Fatalf("declarations %+v", declarations)
	}
}
