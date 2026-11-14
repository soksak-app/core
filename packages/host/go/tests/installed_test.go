package host_test

// Checks the providing of plugins installed in the configuration folder and finding their sidecars (providing installed plugins in docs/spec/installation.md).

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// installedFixture is a configuration folder in which two enabled plugins, one disabled plugin, and one sidecar are installed.
func installedFixture(t *testing.T) string {
	config := t.TempDir()
	support.WriteInstalled(t, config, map[string]string{
		"plugins/installed.json": `{"format": 3, "plugins": {
			"tty": {"version": "0.1.0", "path": "plugins/tty/0.1.0", "enabled": true, "sidecars": {"@scope/sidecar-worker": "^0.1.0"}},
			"alpha": {"version": "1.0.0", "path": "plugins/alpha/1.0.0", "enabled": true, "sidecars": {}},
			"off": {"version": "1.0.0", "path": "plugins/off/1.0.0", "enabled": false, "sidecars": {}}},
			"sidecars": {"@scope/sidecar-worker": {"version": "0.1.2", "path": "sidecars/scope-sidecar-worker/0.1.2/darwin-arm64"}}}`,
		"plugins/tty/0.1.0/package.json":                                `{"name": "@scope/plugin-tty"}`,
		"plugins/alpha/1.0.0/package.json":                              `{"name": "plugin-alpha"}`,
		"plugins/off/1.0.0/package.json":                                `{"name": "plugin-off"}`,
		"plugins/tty/0.1.0/plugin.json":                                 `{"id": "tty", "dependencies": {"@scope/sidecar-worker": "^0.1.0"}}`,
		"plugins/tty/0.1.0/ui/tty.js":                                   "export const tty = 1;",
		"plugins/tty/0.1.0/diagnostics.json":                            "{\n  \"module\": \"ui/d.js\",\n  \"exposes\": {}\n}\n",
		"plugins/alpha/1.0.0/plugin.json":                               `{"id": "alpha"}`,
		"plugins/off/1.0.0/plugin.json":                                 `{"id": "off"}`,
		"sidecars/scope-sidecar-worker/0.1.2/darwin-arm64/sidecar.json": `{"executable": "build/worker", "protocol": 1, "displayName": "soksak://sidecar/probe"}`,
	})
	return config
}

// contract: installed.document.lists-enabled-plugins
func TestInstalledPluginsDocumentListsEnabledPluginsById(t *testing.T) {
	config := installedFixture(t)
	release := `{"plugins":[{"id":"alpha","package":"plugin-alpha","version":"1.0.0","manifest":{"id":"alpha"}},{"id":"tty","package":"@scope/plugin-tty","version":"0.1.0","manifest":{"id":"tty","dependencies":{"@scope/sidecar-worker":"^0.1.0"}},"sidecars":{"@scope/sidecar-worker":{}}}]}`
	if got := string(host.InstalledPluginsDocument(config, false)); got != release {
		t.Fatalf("release document %s", got)
	}
	diagnostic := `{"plugins":[{"id":"alpha","package":"plugin-alpha","version":"1.0.0","manifest":{"id":"alpha"}},{"id":"tty","package":"@scope/plugin-tty","version":"0.1.0","manifest":{"id":"tty","dependencies":{"@scope/sidecar-worker":"^0.1.0"}},"sidecars":{"@scope/sidecar-worker":{}},"diagnostics":{"module":"ui/d.js","exposes":{}}}]}`
	if got := string(host.InstalledPluginsDocument(config, true)); got != diagnostic {
		t.Fatalf("diagnostic document %s", got)
	}
	if got := string(host.InstalledPluginsDocument(t.TempDir(), true)); got != `{"plugins":[]}` {
		t.Fatalf("empty document %s", got)
	}
}

// contract: installed.document.sidecar-facts
func TestInstalledPluginsDocumentDeclaresTheMessageFormOfEachSidecar(t *testing.T) {
	config := installedFixture(t)
	support.WriteInstalled(t, config, map[string]string{
		"sidecars/scope-sidecar-worker/0.1.2/darwin-arm64/sidecar.json": `{"executable": "build/worker", "protocol": 1, "displayName": "soksak://sidecar/probe", "message": {"form": "json-object", "operationField": "operation"}, "hostReadOperations": ["list"]}`,
	})
	want := `{"plugins":[{"id":"alpha","package":"plugin-alpha","version":"1.0.0","manifest":{"id":"alpha"}},{"id":"tty","package":"@scope/plugin-tty","version":"0.1.0","manifest":{"id":"tty","dependencies":{"@scope/sidecar-worker":"^0.1.0"}},"sidecars":{"@scope/sidecar-worker":{"message":{"form":"json-object","operationField":"operation"}}}}]}`
	if got := string(host.InstalledPluginsDocument(config, false)); got != want {
		t.Fatalf("document %s", got)
	}
}

// contract: installed.document.names-from-package-json
func TestInstalledPluginsDocumentReadsTheNameFromThePackageJSON(t *testing.T) {
	config := installedFixture(t)
	support.WriteInstalled(t, config, map[string]string{"plugins/alpha/1.0.0/package.json": `{"name": "plugin-renamed"}`})
	if got := string(host.InstalledPluginsDocument(config, false)); !strings.Contains(got, `{"id":"alpha","package":"plugin-renamed",`) {
		t.Fatalf("renamed document %s", got)
	}
	if err := os.Remove(filepath.Join(config, "plugins/alpha/1.0.0/package.json")); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(config, "plugins/alpha/1.0.0/package.json")
	if got := string(host.InstalledPluginsDocument(config, false)); got != `{"error":"`+file+`: no such file or directory"}` {
		t.Fatalf("missing package.json %s", got)
	}
}

// contract: installed.document.refuses-package
func TestInstalledPluginsDocumentRefusesAPackageField(t *testing.T) {
	config := installedFixture(t)
	// A file of the current format that holds the removed member is refused (docs/spec/installation.md#stored-data-formats).
	support.WriteInstalled(t, config, map[string]string{"plugins/installed.json": `{"format": 3, "plugins": {"alpha": {"package": "plugin-alpha", "version": "1.0.0", "path": "plugins/alpha/1.0.0", "enabled": true, "sidecars": {}}}, "sidecars": {}}`})
	want := `{"error":"` + filepath.Join(config, "plugins/installed.json") + `: plugins/installed.json alpha: unknown field package"}`
	if got := string(host.InstalledPluginsDocument(config, false)); got != want {
		t.Fatalf("package field %s", got)
	}
}

// contract: installed.plugin-json.invalid-text
func TestInstalledPluginJSONInvalidTextNamesOnlyTheFile(t *testing.T) {
	config := installedFixture(t)
	manifest := filepath.Join(config, "plugins/alpha/1.0.0/plugin.json")
	for _, content := range []string{"", "{"} {
		support.WriteInstalled(t, config, map[string]string{"plugins/alpha/1.0.0/plugin.json": content})
		if got, want := string(host.InstalledPluginsDocument(config, false)), `{"error":"`+manifest+` is not valid JSON"}`; got != want {
			t.Fatalf("invalid plugin.json %q: got %s, want %s", content, got, want)
		}
	}
}

// contract: installed.json.invalid-text
func TestInstalledJSONInvalidTextNamesOnlyTheFile(t *testing.T) {
	config := installedFixture(t)
	file := filepath.Join(config, "plugins/installed.json")
	support.WriteInstalled(t, config, map[string]string{"plugins/installed.json": "{"})
	if got, want := string(host.InstalledPluginsDocument(config, false)), `{"error":"`+file+` is not valid JSON"}`; got != want {
		t.Fatalf("invalid installed.json: got %s, want %s", got, want)
	}
}

// contract: installed.package-json.invalid-text
func TestInstalledPackageJSONInvalidTextNamesOnlyTheFile(t *testing.T) {
	config := installedFixture(t)
	file := filepath.Join(config, "plugins/alpha/1.0.0/package.json")
	support.WriteInstalled(t, config, map[string]string{"plugins/alpha/1.0.0/package.json": "{"})
	if got, want := string(host.InstalledPluginsDocument(config, false)), `{"error":"`+file+` is not valid JSON"}`; got != want {
		t.Fatalf("invalid package.json: got %s, want %s", got, want)
	}
}

// contract: installed.document.reports-errors
func TestInstalledPluginsDocumentReportsAnInvalidState(t *testing.T) {
	config := installedFixture(t)
	support.WriteInstalled(t, config, map[string]string{"plugins/tty/0.1.0/diagnostics.json": "{"})
	if got := string(host.InstalledPluginsDocument(config, true)); got != `{"error":"`+filepath.Join(config, "plugins/tty/0.1.0/diagnostics.json")+` is not valid JSON"}` {
		t.Fatalf("diagnostics error %s", got)
	}
	support.WriteInstalled(t, config, map[string]string{"plugins/tty/0.1.0/diagnostics.json": "{}", "plugins/alpha/1.0.0/plugin.json": "{"})
	if got := string(host.InstalledPluginsDocument(config, false)); got != `{"error":"`+filepath.Join(config, "plugins/alpha/1.0.0/plugin.json")+` is not valid JSON"}` {
		t.Fatalf("manifest error %s", got)
	}
	if err := os.Remove(filepath.Join(config, "plugins/alpha/1.0.0/plugin.json")); err != nil {
		t.Fatal(err)
	}
	if got := string(host.InstalledPluginsDocument(config, false)); got != `{"error":"`+filepath.Join(config, "plugins/alpha/1.0.0/plugin.json")+`: the plugin manifest is missing"}` {
		t.Fatalf("missing manifest %s", got)
	}
	support.WriteInstalled(t, config, map[string]string{"plugins/installed.json": `{"format": 9, "plugins": {}, "sidecars": {}}`})
	if got := string(host.InstalledPluginsDocument(config, false)); got != `{"error":"`+filepath.Join(config, "plugins/installed.json")+`: plugins/installed.json: format must be 3"}` {
		t.Fatalf("state error %s", got)
	}
}

// contract: installed.modules.serve-installed-files
func TestInstalledAssetsServeTheFilesOfEnabledPackages(t *testing.T) {
	config := installedFixture(t)
	frontend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "frontend "+r.URL.Path) })
	handler := host.InstalledAssets(config, fstest.MapFS{})(frontend)
	get := func(path string) (int, string, string) {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		return recorder.Code, recorder.Body.String(), recorder.Header().Get("Content-Type")
	}
	if code, body, kind := get("/modules/@scope/plugin-tty/ui/tty.js"); code != 200 || body != "export const tty = 1;" || kind != "text/javascript" {
		t.Fatalf("installed module %d %q %q", code, body, kind)
	}
	for _, path := range []string{"/modules/@scope/plugin-tty/ui/missing.js", "/modules/@scope/plugin-tty/ui/../plugin.json", "/modules/plugin-alpha//plugin.json"} {
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

// contract: installed.modules.unreadable-installation-serves-frontend
func TestAnUnreadableInstallationServesTheFrontendModules(t *testing.T) {
	config := t.TempDir()
	support.WriteInstalled(t, config, map[string]string{"plugins/installed.json": `{"format": 2, "plugins": {}}`})
	frontend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "frontend "+r.URL.Path) })
	handler := host.InstalledAssets(config, fstest.MapFS{})(frontend)
	for _, path := range []string{"/modules/soksak/dist/index.js", "/modules/@soksak/plugin-api/index.js"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != 200 || recorder.Body.String() != "frontend "+path {
			t.Fatalf("%s with an unreadable installation: %d %q", path, recorder.Code, recorder.Body.String())
		}
	}
}

// sharedFixture is a configuration directory where the enabled plugin alpha declares the shared modules of the point
// language and the disabled plugin off declares a point of the same name.
func sharedFixture(t *testing.T) string {
	config := installedFixture(t)
	support.WriteInstalled(t, config, map[string]string{
		"plugins/alpha/1.0.0/plugin.json": `{"id": "alpha", "extends": {"language": {"version": "1.0.0", "schema": {},
			"modules": {"@codemirror/state": "ui/state.js", "gone": "ui/gone.js", "outside": "../../tty/0.1.0/ui/tty.js"}}}}`,
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
	handler := host.InstalledAssets(config, fstest.MapFS{})(frontend)
	get := func(path string) (int, string, string) {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		return recorder.Code, recorder.Body.String(), recorder.Header().Get("Content-Type")
	}
	if code, body, kind := get("/shared/alpha.language/@codemirror/state.js"); code != 200 || body != "export const state = 1;" || kind != "text/javascript" {
		t.Fatalf("shared module %d %q %q", code, body, kind)
	}
	// A path without .js, an undeclared point, an unmapped specifier, a missing file, a path outside the package and a
	// disabled plugin are not found.
	for _, path := range []string{"/shared/alpha.language/@codemirror/state", "/shared/alpha.missing/@codemirror/state.js",
		"/shared/alpha.language/@codemirror/view.js", "/shared/alpha.language/gone.js", "/shared/alpha.language/outside.js",
		"/shared/off.language/x.js", "/shared/nobody.language/x.js", "/shared/alpha", "/shared/alpha.language/.js"} {
		if code, body, _ := get(path); code != 404 {
			t.Fatalf("%s answered %d %q", path, code, body)
		}
	}
	support.WriteInstalled(t, config, map[string]string{"plugins/alpha/1.0.0/plugin.json": "{"})
	if code, body, _ := get("/shared/alpha.language/@codemirror/state.js"); code != 500 || !strings.Contains(body, filepath.Join(config, "plugins/alpha/1.0.0/plugin.json")) {
		t.Fatalf("invalid manifest %d %q", code, body)
	}
}

// contract: installed.sidecars.unreadable-installation-starts-without-sidecars
func TestAnUnreadableInstallationStartsTheSidecarsWithoutDeclarations(t *testing.T) {
	cases := map[string]map[string]string{
		"an earlier installed.json form": {"plugins/installed.json": `{"format": 2, "plugins": {}}`},
		"an invalid plugin.json":         {"plugins/tty/0.1.0/plugin.json": "{"},
	}
	for name, files := range cases {
		config := installedFixture(t)
		support.WriteInstalled(t, config, files)
		sidecars, err := host.NewInstalledSidecars(config)
		if err != nil {
			t.Errorf("%s: the start failed: %v", name, err)
			continue
		}
		err = support.NewSidecarRecorder(t, "/projects/a").Send(sidecars, "@scope/sidecar-worker", "s1", json.RawMessage(`{}`))
		if want := "sidecar @scope/sidecar-worker is not declared by any plugin"; err == nil || err.Error() != want {
			t.Errorf("%s: send error = %v, want %q", name, err, want)
		}
		sidecars.Stop()
	}
}

// installedSendError is the error of a send to the installed sidecar name after the host declares the installed sidecars of config.
func installedSendError(t *testing.T, config, name string) string {
	t.Helper()
	declarations, err := host.InstalledSidecars(config)
	if err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declarations, config)
	if err != nil {
		t.Fatal(err)
	}
	defer sidecars.Stop()
	err = support.NewSidecarRecorder(t, "/projects/a").Send(sidecars, name, "s1", json.RawMessage(`{}`))
	if err == nil {
		t.Fatalf("a send to %s succeeded", name)
	}
	return err.Error()
}

// contract: installed.sidecars.resolve-installed-folders, sidecars.declaration.refuses-missing-sidecar-json
func TestInstalledSidecarsResolveTheInstalledVersionFolders(t *testing.T) {
	config := installedFixture(t)
	declarations, err := host.InstalledSidecars(config)
	if err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(config, "sidecars/scope-sidecar-worker/0.1.2/darwin-arm64")
	if len(declarations) != 1 || declarations[0].Name != "@scope/sidecar-worker" || declarations[0].Folder != folder ||
		string(declarations[0].Data) != `{"executable": "build/worker", "protocol": 1, "displayName": "soksak://sidecar/probe"}` {
		t.Fatalf("declarations %+v", declarations)
	}
	if !reflect.DeepEqual(declarations[0].Dependents, []string{"tty"}) {
		t.Fatalf("dependents %v, want the plugin that lists the sidecar", declarations[0].Dependents)
	}
	if err := os.Remove(filepath.Join(folder, "sidecar.json")); err != nil {
		t.Fatal(err)
	}
	// The sidecar without sidecar.json is not declared, and a send to it names the missing file.
	missing := filepath.Join(folder, "sidecar.json")
	if err := installedSendError(t, config, "@scope/sidecar-worker"); !strings.HasPrefix(err, "sidecar @scope/sidecar-worker: "+missing+": ") {
		t.Fatalf("missing sidecar.json: %s", err)
	}
	support.WriteInstalled(t, config, map[string]string{"plugins/tty/0.1.0/plugin.json": `{"id": "tty", "dependencies": {"@scope/sidecar-other": "^0.1.0"}}`})
	manifest := filepath.Join(config, "plugins/tty/0.1.0/plugin.json")
	if err := installedSendError(t, config, "@scope/sidecar-other"); err != "sidecar @scope/sidecar-other: "+manifest+": sidecar @scope/sidecar-other has no installed version" {
		t.Fatalf("unknown sidecar: %s", err)
	}
	if declarations, err := host.InstalledSidecars(t.TempDir()); err != nil || len(declarations) != 0 {
		t.Fatalf("empty configuration %v %v", declarations, err)
	}
}

// contract: installed.sidecars.dependents-of-a-shared-sidecar
func TestInstalledSidecarsListEveryDependentPlugin(t *testing.T) {
	config := installedFixture(t)
	// A second enabled plugin that lists the same sidecar is one more dependent of the one declaration.
	support.WriteInstalled(t, config, map[string]string{"plugins/alpha/1.0.0/plugin.json": `{"id": "alpha", "dependencies": {"@scope/sidecar-worker": "^0.1.0"}}`})
	declarations, err := host.InstalledSidecars(config)
	if err != nil || len(declarations) != 1 || !reflect.DeepEqual(declarations[0].Dependents, []string{"alpha", "tty"}) {
		t.Fatalf("shared sidecar declarations %+v, %v", declarations, err)
	}
}

// contract: installed.sidecars.leave-out-plugin-dependencies
func TestInstalledSidecarsLeaveOutThePackagesOfInstalledPlugins(t *testing.T) {
	config := installedFixture(t)
	// The packages of an enabled and a disabled plugin are plugin dependencies, not sidecars.
	support.WriteInstalled(t, config, map[string]string{
		"plugins/tty/0.1.0/plugin.json": `{"id": "tty", "dependencies": {"@scope/sidecar-worker": "^0.1.0", "plugin-alpha": "^1.0.0", "plugin-off": "^1.0.0"}}`,
	})
	declarations, err := host.InstalledSidecars(config)
	if err != nil {
		t.Fatal(err)
	}
	if len(declarations) != 1 || declarations[0].Name != "@scope/sidecar-worker" {
		t.Fatalf("declarations %+v", declarations)
	}
}

// contract: document.plugin.folder
func TestPluginFolderIsTheFolderOfTheEnabledInstalledPlugin(t *testing.T) {
	config := installedFixture(t)
	folder, err := host.PluginFolder(config, "alpha")
	if err != nil || folder != filepath.Join(config, "plugins/alpha/1.0.0") {
		t.Fatalf("alpha folder %q %v", folder, err)
	}
	for _, plugin := range []string{"off", "nobody"} {
		if _, err := host.PluginFolder(config, plugin); err == nil || err.Error() != "plugin "+plugin+" is not installed and enabled" {
			t.Fatalf("%s: %v", plugin, err)
		}
	}
}

// contract: document.message.forward
func TestDocumentMessageIsSentToTheSurfaceOrItsReasonIsLogged(t *testing.T) {
	payload, reason, err := host.DocumentMessage("tab-1", "page", `{"message":{"type":"reply","id":3}}`)
	if err != nil || reason != "" {
		t.Fatalf("message %v %q", err, reason)
	}
	if encoded, _ := json.Marshal(payload); string(encoded) != `{"document":"page","message":{"type":"reply","id":3},"surface":"tab-1"}` {
		t.Fatalf("payload %s", encoded)
	}
	if _, reason, err := host.DocumentMessage("tab-1", "page", `{"error":"the message data is not JSON"}`); err != nil || reason != "the message data is not JSON" {
		t.Fatalf("error %v %q", err, reason)
	}
	if _, _, err := host.DocumentMessage("tab-1", "page", `{}`); err == nil || err.Error() != "document message page has neither message nor error" {
		t.Fatalf("empty %v", err)
	}
}

// readsFixture is a configuration folder with the enabled plugins alpha, beta and gamma, each of the package
// plugin-<id>, with the shared module state of the point language.
func readsFixture(t *testing.T) string {
	config := t.TempDir()
	for _, id := range []string{"alpha", "beta", "gamma"} {
		writeReadsPlugin(t, config, id)
	}
	writeReadsRecord(t, config, "alpha", "beta", "gamma")
	return config
}

// writeReadsPlugin writes the files of the plugin id.
func writeReadsPlugin(t *testing.T, config, id string) {
	t.Helper()
	folder := "plugins/" + id + "/1.0.0/"
	support.WriteInstalled(t, config, map[string]string{
		folder + "package.json": `{"name": "plugin-` + id + `"}`,
		folder + "plugin.json": `{"id": "` + id + `", "extends": {"language": {"version": "1.0.0", "schema": {},
			"modules": {"state": "ui/state.js"}}}}`,
		folder + "ui/state.js": "export const state = 1;",
	})
}

// writeReadsRecord writes installed.json with the plugins of ids.
func writeReadsRecord(t *testing.T, config string, ids ...string) {
	t.Helper()
	records := make([]string, len(ids))
	for i, id := range ids {
		records[i] = `"` + id + `": {"version": "1.0.0", "path": "plugins/` + id + `/1.0.0", "enabled": true, "sidecars": {}}`
	}
	support.WriteInstalled(t, config, map[string]string{
		"plugins/installed.json": `{"format": 3, "plugins": {` + strings.Join(records, ",") + `}, "sidecars": {}}`,
	})
}

// filesRead returns the plugin.json and package.json files that requests reads, in order.
func filesRead(t *testing.T, requests func()) []string {
	t.Helper()
	var read []string
	sok.SetAfterPluginFileRead(func(file string) { read = append(read, file) })
	defer sok.SetAfterPluginFileRead(nil)
	requests()
	return read
}

// manifestsRead returns the plugin.json files that requests reads, in order.
func manifestsRead(t *testing.T, requests func()) []string {
	t.Helper()
	return slices.DeleteFunc(filesRead(t, requests), func(file string) bool { return filepath.Base(file) != "plugin.json" })
}

// readsRepeated is the manifest once for each of the requests of a read test.
func readsRepeated(manifest string) []string {
	return slices.Repeat([]string{manifest}, readsRequests)
}

// readsRequests is the number of times that a read test asks for a module.
const readsRequests = 5

// checkModule fails unless urlPath is the installed file, relative to config, or the frontend for an empty file.
func checkModule(t *testing.T, config, urlPath, file string) {
	t.Helper()
	got, installed, found, err := host.InstalledModule(config, urlPath)
	if file == "" {
		if err != nil || installed || found {
			t.Fatalf("%s: file %q installed %v found %v error %v, want the frontend", urlPath, got, installed, found, err)
		}
		return
	}
	if want := filepath.Join(config, filepath.FromSlash(file)); err != nil || !installed || !found || got != want {
		t.Fatalf("%s: file %q installed %v found %v error %v, want %s", urlPath, got, installed, found, err, want)
	}
}

// checkShared fails unless urlPath is the shared file, relative to config, or is not found for an empty file.
func checkShared(t *testing.T, config, urlPath, file string) {
	t.Helper()
	got, shared, found, err := host.InstalledShared(config, urlPath)
	if file == "" {
		if err != nil || !shared || found {
			t.Fatalf("%s: file %q shared %v found %v error %v, want not found", urlPath, got, shared, found, err)
		}
		return
	}
	if want := filepath.Join(config, filepath.FromSlash(file)); err != nil || !shared || !found || got != want {
		t.Fatalf("%s: file %q shared %v found %v error %v, want %s", urlPath, got, shared, found, err, want)
	}
}

// contract: installed.modules.read-the-manifest-of-the-request
func TestAModuleOfAPluginReadsTheManifestOfThatPluginAlone(t *testing.T) {
	config := readsFixture(t)
	read := manifestsRead(t, func() {
		for range readsRequests {
			checkModule(t, config, "/modules/plugin-beta/ui/state.js", "plugins/beta/1.0.0/ui/state.js")
		}
	})
	if want := readsRepeated(filepath.Join(config, "plugins", "beta", "1.0.0", "plugin.json")); !slices.Equal(read, want) {
		t.Fatalf("read %v, want %v", read, want)
	}
}

// contract: installed.modules.read-the-manifest-of-the-request
func TestAModuleOfTheFrontendReadsNoManifest(t *testing.T) {
	config := readsFixture(t)
	read := manifestsRead(t, func() {
		for range readsRequests {
			checkModule(t, config, "/modules/soksak/dist/index.js", "")
		}
	})
	if len(read) != 0 {
		t.Fatalf("read %v, want no manifest", read)
	}
}

// contract: installed.modules.read-the-manifest-of-the-request
func TestASharedModuleReadsTheManifestOfItsProviderAlone(t *testing.T) {
	config := readsFixture(t)
	read := manifestsRead(t, func() {
		for range readsRequests {
			checkShared(t, config, "/shared/beta.language/state.js", "plugins/beta/1.0.0/ui/state.js")
		}
	})
	if want := readsRepeated(filepath.Join(config, "plugins", "beta", "1.0.0", "plugin.json")); !slices.Equal(read, want) {
		t.Fatalf("read %v, want %v", read, want)
	}
}

// contract: installed.modules.read-the-manifest-of-the-request
func TestAMalformedManifestRefusesTheModulesOfItsOwnPluginAlone(t *testing.T) {
	config := readsFixture(t)
	support.WriteInstalled(t, config, map[string]string{"plugins/alpha/1.0.0/plugin.json": "{"})
	checkModule(t, config, "/modules/plugin-beta/ui/state.js", "plugins/beta/1.0.0/ui/state.js")
	checkShared(t, config, "/shared/beta.language/state.js", "plugins/beta/1.0.0/ui/state.js")
	checkModule(t, config, "/modules/plugin-alpha/ui/state.js", "")
	manifest := filepath.Join(config, "plugins", "alpha", "1.0.0", "plugin.json")
	if _, _, _, err := host.InstalledShared(config, "/shared/alpha.language/state.js"); err == nil || !strings.Contains(err.Error(), manifest) {
		t.Fatalf("error %v, want one that names %s", err, manifest)
	}
}

// contract: installed.modules.follow-the-installation
func TestTheRequestAfterAnInstallServesTheNewPlugin(t *testing.T) {
	config := readsFixture(t)
	checkModule(t, config, "/modules/plugin-delta/ui/state.js", "")
	checkShared(t, config, "/shared/delta.language/state.js", "")
	writeReadsPlugin(t, config, "delta")
	writeReadsRecord(t, config, "alpha", "beta", "gamma", "delta")
	checkModule(t, config, "/modules/plugin-delta/ui/state.js", "plugins/delta/1.0.0/ui/state.js")
	checkShared(t, config, "/shared/delta.language/state.js", "plugins/delta/1.0.0/ui/state.js")
}

// contract: installed.modules.follow-the-installation
func TestTheRequestAfterARemovalDoesNotServeThePlugin(t *testing.T) {
	config := readsFixture(t)
	checkModule(t, config, "/modules/plugin-beta/ui/state.js", "plugins/beta/1.0.0/ui/state.js")
	checkShared(t, config, "/shared/beta.language/state.js", "plugins/beta/1.0.0/ui/state.js")
	writeReadsRecord(t, config, "alpha", "gamma")
	checkModule(t, config, "/modules/plugin-beta/ui/state.js", "")
	checkShared(t, config, "/shared/beta.language/state.js", "")
}

// contract: installed.modules.follow-the-installation
func TestTheRequestAfterAnUpdateReadsTheNewManifest(t *testing.T) {
	config := readsFixture(t)
	checkShared(t, config, "/shared/beta.language/state.js", "plugins/beta/1.0.0/ui/state.js")
	support.WriteInstalled(t, config, map[string]string{"plugins/beta/1.0.0/plugin.json": `{"id": "beta", "extends": {"language": {"version": "1.0.0",
		"schema": {}, "modules": {"other": "ui/state.js"}}}}`})
	checkShared(t, config, "/shared/beta.language/state.js", "")
}

// readsCoreModule is the file of a core package that the bundled frontend of a read test holds.
const readsCoreModule = "/modules/soksak/dist/index.js"

// readsPageFiles is the handler of the page files of a host on config, whose next handler answers core.
func readsPageFiles(config string) http.Handler {
	frontend := fstest.MapFS{"modules/soksak/dist/index.js": {Data: []byte("core")}}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "core") })
	return host.InstalledAssets(config, frontend)(next)
}

// readsAnswer is the body of the answer of handler to urlPath.
func readsAnswer(handler http.Handler, urlPath string) string {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, urlPath, nil))
	return recorder.Body.String()
}

// contract: installed.modules.frontend-first
func TestAFileOfTheFrontendReadsNoFileOfAPlugin(t *testing.T) {
	handler := readsPageFiles(readsFixture(t))
	read := filesRead(t, func() {
		for range readsRequests {
			if body := readsAnswer(handler, readsCoreModule); body != "core" {
				t.Fatalf("answer %q", body)
			}
		}
	})
	if len(read) != 0 {
		t.Fatalf("read %v, want no file of a plugin", read)
	}
}

// contract: installed.modules.frontend-first
func TestAFileOfTheFrontendWinsOverAPluginOfTheSamePackage(t *testing.T) {
	config := readsFixture(t)
	support.WriteInstalled(t, config, map[string]string{
		"plugins/alpha/1.0.0/package.json":  `{"name": "soksak"}`,
		"plugins/alpha/1.0.0/dist/index.js": "plugin",
		"plugins/alpha/1.0.0/dist/other.js": "plugin other",
	})
	handler := readsPageFiles(config)
	if body := readsAnswer(handler, readsCoreModule); body != "core" {
		t.Fatalf("core file answered %q", body)
	}
	if body := readsAnswer(handler, "/modules/soksak/dist/other.js"); body != "plugin other" {
		t.Fatalf("other file answered %q", body)
	}
}

// contract: installed.modules.read-the-manifest-of-the-request
func TestAModuleOfAPluginStopsReadingAtItsPackage(t *testing.T) {
	config := readsFixture(t)
	read := filesRead(t, func() {
		checkModule(t, config, "/modules/plugin-beta/ui/state.js", "plugins/beta/1.0.0/ui/state.js")
	})
	want := []string{
		filepath.Join(config, "plugins", "alpha", "1.0.0", "package.json"),
		filepath.Join(config, "plugins", "beta", "1.0.0", "package.json"),
		filepath.Join(config, "plugins", "beta", "1.0.0", "plugin.json"),
	}
	if !slices.Equal(read, want) {
		t.Fatalf("read %v, want %v", read, want)
	}
}

// contract: installed.modules.read-the-manifest-of-the-request
func TestAModuleBesideAMalformedPackageJSONIsServed(t *testing.T) {
	config := readsFixture(t)
	support.WriteInstalled(t, config, map[string]string{"plugins/alpha/1.0.0/package.json": "{"})
	checkModule(t, config, "/modules/plugin-beta/ui/state.js", "plugins/beta/1.0.0/ui/state.js")
	checkModule(t, config, "/modules/plugin-alpha/ui/state.js", "")
}

// contract: document.plugin.folder
func TestThePluginFolderReadsTheManifestOfItsPluginAlone(t *testing.T) {
	config := readsFixture(t)
	beta := filepath.Join(config, "plugins", "beta", "1.0.0")
	read := filesRead(t, func() {
		if folder, err := host.PluginFolder(config, "beta"); err != nil || folder != beta {
			t.Fatalf("folder %q error %v", folder, err)
		}
	})
	if want := []string{filepath.Join(beta, "plugin.json")}; !slices.Equal(read, want) {
		t.Fatalf("read %v, want %v", read, want)
	}
}

// contract: document.plugin.folder
func TestThePluginFolderIsFoundBesideAMalformedPlugin(t *testing.T) {
	config := readsFixture(t)
	support.WriteInstalled(t, config, map[string]string{
		"plugins/alpha/1.0.0/plugin.json":  "{",
		"plugins/gamma/1.0.0/package.json": "{",
	})
	if folder, err := host.PluginFolder(config, "beta"); err != nil || folder != filepath.Join(config, "plugins", "beta", "1.0.0") {
		t.Fatalf("folder %q error %v", folder, err)
	}
	manifest := filepath.Join(config, "plugins", "alpha", "1.0.0", "plugin.json")
	if _, err := host.PluginFolder(config, "alpha"); err == nil || !strings.Contains(err.Error(), manifest) {
		t.Fatalf("error %v, want one that names %s", err, manifest)
	}
}

// contract: document.plugin.folder
func TestThePluginFolderFollowsTheInstallation(t *testing.T) {
	config := readsFixture(t)
	if _, err := host.PluginFolder(config, "beta"); err != nil {
		t.Fatal(err)
	}
	writeReadsRecord(t, config, "alpha", "gamma")
	if _, err := host.PluginFolder(config, "beta"); err == nil || err.Error() != "plugin beta is not installed and enabled" {
		t.Fatalf("removed plugin: %v", err)
	}
	writeReadsRecord(t, config, "alpha", "beta", "gamma")
	if _, err := host.PluginFolder(config, "beta"); err != nil {
		t.Fatal(err)
	}
}
