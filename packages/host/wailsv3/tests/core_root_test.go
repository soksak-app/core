package host_test

// Checks the core root of a view: the core files of the view import map and the files that the granted item rule grants
// (docs/spec/plugin-processes.md, rule 4).

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// coreFrontend is the bundled frontend. It holds the core files and also the paths that a view must not receive.
func coreFrontend() fstest.MapFS {
	return fstest.MapFS{
		"core-root.json":                      {Data: []byte(`["/modules/@soksak/plugin-api/index.js","/modules/soksak/dist/index.js"]`)},
		"modules/@soksak/plugin-api/index.js": {Data: []byte("export const index = 1;")},
		"modules/soksak/dist/index.js":        {Data: []byte("export const soksak = 1;")},
		"runtime/index.js":                    {Data: []byte("export const runtime = 1;")},
		"environment.json":                    {Data: []byte(`{"plugins":[]}`)},
		"start.json":                          {Data: []byte(`{}`)},
		"index.html":                          {Data: []byte(`<!doctype html>`)},
	}
}

// coreRootFixture is a configuration folder with four enabled plugins and one disabled plugin. The provider declares the
// point list with a shared module. The view contributes the module ui/item.js to the point provider.list. The view also
// depends on the provider, which grants no file. The other plugin owns a file that no plugin is granted.
func coreRootFixture(t *testing.T) string {
	config := t.TempDir()
	writeInstalled(t, config, map[string]string{
		"plugins/installed.json": `{"format": 3, "plugins": {
			"provider": {"version": "1.0.0", "path": "plugins/provider/1.0.0", "enabled": true, "sidecars": {}},
			"view": {"version": "1.0.0", "path": "plugins/view/1.0.0", "enabled": true, "sidecars": {}},
			"other": {"version": "1.0.0", "path": "plugins/other/1.0.0", "enabled": true, "sidecars": {}},
			"off": {"version": "1.0.0", "path": "plugins/off/1.0.0", "enabled": false, "sidecars": {}}},
			"sidecars": {}}`,
		"plugins/provider/1.0.0/package.json": `{"name": "plugin-provider"}`,
		"plugins/provider/1.0.0/plugin.json":  `{"id": "provider", "extends": {"list": {"version": "1.0.0", "modules": {"format": "ui/format.js"}}}}`,
		"plugins/provider/1.0.0/ui/format.js": "export const format = 1;",
		"plugins/provider/1.0.0/ui/own.js":    "export const own = 1;",
		"plugins/view/1.0.0/package.json":     `{"name": "plugin-view"}`,
		"plugins/view/1.0.0/plugin.json":      `{"id": "view", "dependencies": {"plugin-provider": "^1.0.0"}, "contributes": {"provider.list": [{"range": "^1.0.0", "module": "ui/item.js"}]}}`,
		"plugins/view/1.0.0/ui/item.js":       "export const item = 1;",
		"plugins/view/1.0.0/ui/secret.js":     "export const secret = 1;",
		"plugins/other/1.0.0/package.json":    `{"name": "plugin-other"}`,
		"plugins/other/1.0.0/plugin.json":     `{"id": "other"}`,
		"plugins/other/1.0.0/secret.js":       "export const other = 1;",
		"plugins/off/1.0.0/package.json":      `{"name": "plugin-off"}`,
		"plugins/off/1.0.0/plugin.json":       `{"id": "off"}`,
	})
	return config
}

// coreRootServed checks that the core root serves the file at urlPath to plugin with the content and the content type.
func coreRootServed(t *testing.T, config, plugin, urlPath, content string) {
	t.Helper()
	file, found, err := host.CoreRoot(config, plugin, urlPath, coreFrontend())
	if err != nil {
		t.Fatalf("%s for %s: %v", urlPath, plugin, err)
	}
	if !found {
		t.Fatalf("%s for %s: not found, want the file", urlPath, plugin)
	}
	if string(file.Data) != content {
		t.Fatalf("%s for %s: data %q, want %q", urlPath, plugin, file.Data, content)
	}
	if file.ContentType != "text/javascript" {
		t.Fatalf("%s for %s: content type %q, want text/javascript", urlPath, plugin, file.ContentType)
	}
}

// coreRootRefused checks that the core root answers not found for urlPath to plugin and writes the refusal as an error.
func coreRootRefused(t *testing.T, written func() string, config, plugin, urlPath string) {
	t.Helper()
	_, found, err := host.CoreRoot(config, plugin, urlPath, coreFrontend())
	if err != nil {
		t.Fatalf("%s for %s: %v", urlPath, plugin, err)
	}
	if found {
		t.Fatalf("%s for %s: found, want not found", urlPath, plugin)
	}
	want := "error host core root: " + urlPath + " is not granted to " + plugin
	if !strings.Contains(written(), want) {
		t.Fatalf("%s for %s: the log has no %q", urlPath, plugin, want)
	}
}

// contract: document.core-root.grant
func TestCoreRootServesAGrantedModule(t *testing.T) {
	config := coreRootFixture(t)
	coreRootServed(t, config, "provider", "/modules/plugin-view/ui/item.js", "export const item = 1;")
}

// contract: document.core-root.grant
func TestCoreRootServesASharedTarget(t *testing.T) {
	config := coreRootFixture(t)
	coreRootServed(t, config, "provider", "/shared/provider.list/format.js", "export const format = 1;")
	coreRootServed(t, config, "view", "/shared/provider.list/format.js", "export const format = 1;")
}

// contract: document.core-root.grant
func TestCoreRootServesACoreFile(t *testing.T) {
	config := coreRootFixture(t)
	coreRootServed(t, config, "provider", "/modules/@soksak/plugin-api/index.js", "export const index = 1;")
	coreRootServed(t, config, "other", "/modules/soksak/dist/index.js", "export const soksak = 1;")
}

// contract: document.core-root.grant
func TestCoreRootRefusesAnUnrelatedPluginFile(t *testing.T) {
	config := coreRootFixture(t)
	written := captureLog(t)
	coreRootRefused(t, written, config, "provider", "/modules/plugin-other/secret.js")
	coreRootRefused(t, written, config, "provider", "/modules/plugin-view/ui/secret.js")
	coreRootRefused(t, written, config, "provider", "/modules/plugin-provider/ui/own.js")
	coreRootRefused(t, written, config, "view", "/modules/plugin-provider/ui/format.js")
	coreRootRefused(t, written, config, "other", "/modules/plugin-view/ui/item.js")
}

// contract: document.core-root.grant
func TestCoreRootRefusesRuntimeAndWorkbenchPaths(t *testing.T) {
	config := coreRootFixture(t)
	written := captureLog(t)
	for _, urlPath := range []string{"/runtime/index.js", "/environment.json", "/start.json", "/index.html"} {
		coreRootRefused(t, written, config, "provider", urlPath)
	}
}

// contract: document.core-root.grant
func TestCoreRootRefusesARequesterThatIsNotEnabled(t *testing.T) {
	config := coreRootFixture(t)
	written := captureLog(t)
	coreRootRefused(t, written, config, "off", "/modules/@soksak/plugin-api/index.js")
	coreRootRefused(t, written, config, "nobody", "/modules/@soksak/plugin-api/index.js")
}

// contract: document.core-root.grant
func TestCoreRootFailsAGrantedFileThatIsMissing(t *testing.T) {
	config := coreRootFixture(t)
	if err := os.Remove(filepath.Join(config, "plugins/view/1.0.0/ui/item.js")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := host.CoreRoot(config, "provider", "/modules/plugin-view/ui/item.js", coreFrontend()); err == nil {
		t.Fatal("a granted file that is missing is not an error")
	}
}

// contract: document.core-root.grant
func TestCoreRootReadsTheTargetsFromTheCoreRootFile(t *testing.T) {
	config := coreRootFixture(t)
	frontend := coreFrontend()
	frontend["core-root.json"] = &fstest.MapFile{Data: []byte(`["/modules/@soksak/plugin-api/index.js"]`)}
	written := captureLog(t)
	file, found, err := host.CoreRoot(config, "other", "/modules/@soksak/plugin-api/index.js", frontend)
	if err != nil || !found || string(file.Data) != "export const index = 1;" {
		t.Fatalf("a target that the list names: found %v, err %v, data %q", found, err, file.Data)
	}
	_, found, err = host.CoreRoot(config, "other", "/modules/soksak/dist/index.js", frontend)
	if err != nil || found {
		t.Fatalf("a core file that the list does not name: found %v, err %v, want not found", found, err)
	}
	if want := "error host core root: /modules/soksak/dist/index.js is not granted to other"; !strings.Contains(written(), want) {
		t.Fatalf("the log has no %q", want)
	}
}

// contract: document.core-root.grant
func TestCoreRootFailsAMissingCoreRootFile(t *testing.T) {
	config := coreRootFixture(t)
	frontend := coreFrontend()
	delete(frontend, "core-root.json")
	if _, _, err := host.CoreRoot(config, "provider", "/modules/@soksak/plugin-api/index.js", frontend); err == nil {
		t.Fatal("a missing core-root.json is not an error")
	}
}

// contract: document.core-root.grant
func TestCoreRootFailsAMalformedCoreRootFile(t *testing.T) {
	config := coreRootFixture(t)
	for _, text := range []string{`{"targets": []}`, `null`, `["/runtime/index.js"]`, `not json`} {
		frontend := coreFrontend()
		frontend["core-root.json"] = &fstest.MapFile{Data: []byte(text)}
		if _, _, err := host.CoreRoot(config, "provider", "/modules/@soksak/plugin-api/index.js", frontend); err == nil {
			t.Fatalf("core-root.json %s is not an error", text)
		}
	}
}

// coreRootHost is the platform fake that keeps the core root resolver and the view import map that the host registers.
type coreRootHost struct {
	resolve   platform.CoreRootResolver
	importMap string
}

func (h *coreRootHost) SetViewImportMap(text string) error {
	h.importMap = text
	return nil
}

func (h *coreRootHost) SetCoreRoot(resolve platform.CoreRootResolver) error {
	h.resolve = resolve
	return nil
}

// registeredCoreRoot registers the core root of config with a fake platform and returns the resolver of the host.
func registeredCoreRoot(t *testing.T, config string) platform.CoreRootResolver {
	t.Helper()
	fake := &coreRootHost{}
	if err := host.RegisterCoreRoot(fake, config, coreFrontend()); err != nil {
		t.Fatalf("the host did not register the core root: %v", err)
	}
	if fake.resolve == nil {
		t.Fatal("the host registered no core root resolver")
	}
	return fake.resolve
}

// contract: document.core-root.native
func TestCoreRootResolverAnswersAViewThroughThePlatform(t *testing.T) {
	config := coreRootFixture(t)
	resolve := registeredCoreRoot(t, config)

	data, contentType, found := resolve("provider", "/modules/plugin-view/ui/item.js")
	if !found || string(data) != "export const item = 1;" || contentType != "text/javascript" {
		t.Fatalf("a granted module: found %v, data %q, type %q, want the module as text/javascript", found, data, contentType)
	}
	data, contentType, found = resolve("view", "/shared/provider.list/format.js")
	if !found || string(data) != "export const format = 1;" || contentType != "text/javascript" {
		t.Fatalf("a shared target: found %v, data %q, type %q, want the shared target as text/javascript", found, data, contentType)
	}
	data, contentType, found = resolve("provider", "/modules/@soksak/plugin-api/index.js")
	if !found || string(data) != "export const index = 1;" {
		t.Fatalf("a core file: found %v, data %q, want the core file", found, data)
	}
}

// contract: document.core-root.native
func TestCoreRootResolverRefusesAPathThroughThePlatform(t *testing.T) {
	config := coreRootFixture(t)
	resolve := registeredCoreRoot(t, config)
	written := captureLog(t)

	if _, _, found := resolve("provider", "/runtime/index.js"); found {
		t.Fatal("a runtime path is found, want not found")
	}
	if want := "error host core root: /runtime/index.js is not granted to provider"; !strings.Contains(written(), want) {
		t.Fatalf("the log has no %q", want)
	}
	if _, _, found := resolve("nobody", "/modules/@soksak/plugin-api/index.js"); found {
		t.Fatal("a requester that is not installed is found, want not found")
	}
}

// contract: document.core-root.native
func TestCoreRootResolverReportsAGrantedFileThatIsMissing(t *testing.T) {
	config := coreRootFixture(t)
	if err := os.Remove(filepath.Join(config, "plugins/view/1.0.0/ui/item.js")); err != nil {
		t.Fatal(err)
	}
	resolve := registeredCoreRoot(t, config)
	written := captureLog(t)

	if _, _, found := resolve("provider", "/modules/plugin-view/ui/item.js"); found {
		t.Fatal("a granted file that is missing is found, want not found")
	}
	if want := "error host core root: /modules/plugin-view/ui/item.js is granted to provider, but its file is missing"; !strings.Contains(written(), want) {
		t.Fatalf("the log has no %q", want)
	}
}

// viewImportsText is the view import map that staging writes to view-imports.json, which the tests give the bundled frontend.
const viewImportsText = `{"imports":{"soksak":"sok://core/modules/soksak/dist/index.js"}}`

// contract: document.view-import-map.native
func TestViewImportMapIsSetFromTheStagedFile(t *testing.T) {
	fake := &coreRootHost{}
	frontend := coreFrontend()
	frontend["view-imports.json"] = &fstest.MapFile{Data: []byte(viewImportsText)}
	if err := host.RegisterViewImportMap(fake, frontend); err != nil {
		t.Fatalf("the host did not set the view import map: %v", err)
	}
	if fake.importMap != viewImportsText {
		t.Fatalf("the host set %q, want %q", fake.importMap, viewImportsText)
	}
}

// contract: document.view-import-map.native
func TestViewImportMapFailsWithoutTheStagedFile(t *testing.T) {
	if err := host.RegisterViewImportMap(&coreRootHost{}, coreFrontend()); err == nil {
		t.Fatal("a bundled frontend without view-imports.json sets no view import map")
	}
}
