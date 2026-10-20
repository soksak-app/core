package host

// Provides the plugins installed in the configuration folder to the page and finds their sidecars (the section on providing installed plugins of docs/spec/installation.md). A file is read only from
// the folder that the installation recorded in installed.json. The install state is read for every request, so a page loaded after a change sees that change.
// The format check uses the implementation of the command line sok.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// diagnosticPlugins is true in a diagnostic build. The init of diagnostics.go turns it on, and when it is true, /installed-plugins.json
// holds the diagnostics.json of the installed plugins.
var diagnosticPlugins bool

// InstalledPluginsPath is the path from which the page reads the list of installed plugins.
const InstalledPluginsPath = "/installed-plugins.json"

// installedPlugin is one enabled installed plugin and its file folder.
type installedPlugin struct {
	id, pkg, version, dir string
	manifest              []byte
}

// enabledPlugins returns the enabled installed plugins in the order of their ids. The install folder is recorded as a path relative to the configuration folder, and the conversion report of
// a format 1 file is written to the standard error, which is the application log (docs/spec/installation.md).
func enabledPlugins(configDir string) ([]installedPlugin, *sok.InstalledState, error) {
	state, manifests, err := sok.ReadInstalledManifests(configDir)
	if err != nil {
		return nil, nil, err
	}
	var plugins []installedPlugin
	for id, plugin := range state.Plugins {
		if !plugin.Enabled {
			continue
		}
		name, err := sok.InstalledName(configDir, plugin)
		if err != nil {
			return nil, nil, err
		}
		manifest, ok := manifests[id]
		if !ok {
			return nil, nil, fmt.Errorf("plugin %s has no installed manifest", id)
		}
		plugins = append(plugins, installedPlugin{id: id, pkg: name, version: plugin.Version, dir: filepath.Join(configDir, plugin.Path), manifest: manifest.Compact})
	}
	slices.SortFunc(plugins, func(a, b installedPlugin) int { return strings.Compare(a.id, b.id) })
	return plugins, state, nil
}

// PluginFolder returns the folder of the enabled installed plugin, which the document regions of its surfaces serve
// at sok://<plugin>/ (docs/spec/native-surfaces.md#document-regions).
func PluginFolder(configDir, plugin string) (string, error) {
	plugins, _, err := enabledPlugins(configDir)
	if err != nil {
		return "", err
	}
	index := slices.IndexFunc(plugins, func(entry installedPlugin) bool { return entry.id == plugin })
	if index < 0 {
		return "", fmt.Errorf("plugin %s is not installed and enabled", plugin)
	}
	return plugins[index].dir, nil
}

// InstalledPluginsDocument is the content of /installed-plugins.json. For each plugin, it holds the installed plugin.json as a manifest so that
// the page registers the plugins before the first screen. When the install state cannot be read, it is a { "error" } document.
func InstalledPluginsDocument(configDir string, diagnostics bool) []byte {
	type entry struct {
		ID          string          `json:"id"`
		Package     string          `json:"package"`
		Version     string          `json:"version"`
		Manifest    json.RawMessage `json:"manifest"`
		Diagnostics json.RawMessage `json:"diagnostics,omitempty"`
	}
	failure := func(err error) []byte {
		data, marshalErr := json.Marshal(map[string]string{"error": err.Error()})
		if marshalErr != nil {
			return []byte(`{"error":"the error text cannot be encoded"}`)
		}
		return data
	}
	plugins, _, err := enabledPlugins(configDir)
	if err != nil {
		return failure(err)
	}
	entries := []entry{}
	for _, plugin := range plugins {
		item := entry{ID: plugin.id, Package: plugin.pkg, Version: plugin.version, Manifest: plugin.manifest}
		if diagnostics {
			file := filepath.Join(plugin.dir, "diagnostics.json")
			data, err := os.ReadFile(file)
			switch {
			case errors.Is(err, os.ErrNotExist):
				// default: a plugin without diagnostics.json has no diagnostic declaration.
			case err != nil:
				return failure(err)
			case !json.Valid(data):
				return failure(fmt.Errorf("%s is not valid JSON", file))
			default:
				var compact bytes.Buffer
				if err := json.Compact(&compact, data); err != nil {
					return failure(err)
				}
				item.Diagnostics = compact.Bytes()
			}
		}
		entries = append(entries, item)
	}
	data, err := json.Marshal(map[string]any{"plugins": entries})
	if err != nil {
		return failure(err)
	}
	return data
}

// InstalledModule returns the path when /modules/<package>/<path> is a file of an enabled installed plugin. When installed is
// false, that module belongs to the application frontend. When the path is wrong, found is false.
func InstalledModule(configDir, urlPath string) (file string, installed, found bool, err error) {
	rest, ok := strings.CutPrefix(urlPath, "/modules/")
	if !ok {
		return "", false, false, nil
	}
	parts := strings.Split(rest, "/")
	count := 1
	if strings.HasPrefix(parts[0], "@") {
		count = 2
	}
	if len(parts) <= count {
		return "", false, false, nil
	}
	name := strings.Join(parts[:count], "/")
	plugins, _, err := enabledPlugins(configDir)
	if err != nil {
		return "", false, false, err
	}
	index := slices.IndexFunc(plugins, func(plugin installedPlugin) bool { return plugin.pkg == name })
	if index < 0 {
		return "", false, false, nil
	}
	file, found = insidePackage(plugins[index].dir, parts[count:])
	return file, true, found, nil
}

// insidePackage returns the file at a relative path inside a package when every part of the path is a name and the
// file is a regular file.
func insidePackage(dir string, parts []string) (string, bool) {
	if slices.ContainsFunc(parts, func(part string) bool { return part == "" || part == "." || part == ".." }) {
		return "", false
	}
	file := filepath.Join(dir, filepath.FromSlash(path.Join(parts...)))
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return file, true
}

// coreRootFile is the file of the bundled frontend that lists the core targets of the view import map. The staging tool
// writes it from viewCoreTargets of @soksak/plugin-api (CORE_ROOT_FILE), so the host holds no copy of the list.
const coreRootFile = "core-root.json"

// coreRootTargets reads the core targets of the view import map from core-root.json of the bundled frontend. A missing
// file, a file that is not a JSON array of core target paths, or a path outside /modules is an error.
func coreRootTargets(frontend fs.FS) (map[string]bool, error) {
	data, err := fs.ReadFile(frontend, coreRootFile)
	if err != nil {
		return nil, fmt.Errorf("%s: the core targets are missing from the bundled frontend: %w", coreRootFile, err)
	}
	var paths []string
	if err := json.Unmarshal(data, &paths); err != nil || paths == nil {
		return nil, fmt.Errorf("%s: expected a JSON array of core target paths", coreRootFile)
	}
	targets := make(map[string]bool, len(paths))
	for _, target := range paths {
		if !strings.HasPrefix(target, "/modules/") {
			return nil, fmt.Errorf("%s: %q is not a core target path", coreRootFile, target)
		}
		targets[target] = true
	}
	return targets, nil
}

// CoreRootFile is a file that the core root serves to a view: its content and its content type.
type CoreRootFile struct {
	Data        []byte
	ContentType string
}

// CoreRoot returns the file at urlPath of the core root for a view of plugin (docs/plans/plugin-processes.md, rule 4).
// A core target is read from the bundled frontend. Any other path is read from an installed plugin folder only when the
// granted item rule (sok.GrantedFiles) grants it to plugin; the rule reads the installation record at each request.
// found is false for a refused path, and the refusal is written as an error record. err is set when the requester
// is installed but its declarations are malformed, or when a core target or a granted file is missing or unreadable.
func CoreRoot(configDir, plugin, urlPath string, frontend fs.FS) (file CoreRootFile, found bool, err error) {
	targets, err := coreRootTargets(frontend)
	if err != nil {
		return CoreRootFile{}, false, err
	}
	plugins, state, err := enabledPlugins(configDir)
	if err != nil {
		return CoreRootFile{}, false, err
	}
	if !slices.ContainsFunc(plugins, func(entry installedPlugin) bool { return entry.id == plugin }) {
		return refuseCoreRoot(urlPath, plugin)
	}
	if targets[urlPath] {
		data, err := fs.ReadFile(frontend, strings.TrimPrefix(urlPath, "/"))
		if err != nil {
			return CoreRootFile{}, false, fmt.Errorf("%s: the core file is missing from the bundled frontend: %w", urlPath, err)
		}
		return CoreRootFile{Data: data, ContentType: coreContentType(urlPath)}, true, nil
	}
	files := map[string]sok.PluginFiles{}
	for _, entry := range plugins {
		manifestFile := filepath.Join(entry.dir, "plugin.json")
		data, err := os.ReadFile(manifestFile)
		if err != nil {
			return CoreRootFile{}, false, err
		}
		var manifest any
		if err := json.Unmarshal(data, &manifest); err != nil {
			return CoreRootFile{}, false, fmt.Errorf("%s: %w", manifestFile, err)
		}
		files[entry.id] = sok.PluginFiles{Package: entry.pkg, Manifest: manifest}
	}
	granted, err := sok.GrantedFiles(state, files, plugin)
	if err != nil {
		return CoreRootFile{}, false, err
	}
	if !slices.Contains(granted, urlPath) {
		return refuseCoreRoot(urlPath, plugin)
	}
	lookup := InstalledModule
	if strings.HasPrefix(urlPath, SharedPrefix) {
		lookup = InstalledShared
	}
	target, _, exists, err := lookup(configDir, urlPath)
	if err != nil {
		return CoreRootFile{}, false, err
	}
	if !exists {
		return CoreRootFile{}, false, fmt.Errorf("%s is granted to %s, but its file is missing", urlPath, plugin)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return CoreRootFile{}, false, err
	}
	return CoreRootFile{Data: data, ContentType: coreContentType(urlPath)}, true, nil
}

// RegisterCoreRoot registers the core root resolver of the configuration folder with the platform. The resolver answers each
// request of a view with CoreRoot. An error of CoreRoot is written to the application log, and the request is answered not found.
func RegisterCoreRoot(system platform.CoreRootHost, configDir string, frontend fs.FS) error {
	return system.SetCoreRoot(func(plugin, urlPath string) ([]byte, string, bool) {
		file, found, err := CoreRoot(configDir, plugin, urlPath, frontend)
		if err != nil {
			LogError("core root", err)
			return nil, "", false
		}
		return file.Data, file.ContentType, found
	})
}

// refuseCoreRoot writes the refusal of urlPath for plugin as an error record and returns the not found result.
func refuseCoreRoot(urlPath, plugin string) (CoreRootFile, bool, error) {
	LogError("core root", urlPath+" is not granted to "+plugin)
	return CoreRootFile{}, false, nil
}

// coreContentType returns the content type of a core root file by its extension. The table is fixed, so that both hosts
// give a file the same type.
func coreContentType(urlPath string) string {
	switch path.Ext(urlPath) {
	case ".js", ".mjs":
		return "text/javascript"
	case ".json":
		return "application/json"
	case ".css":
		return "text/css"
	case ".html":
		return "text/html"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	}
	return "application/octet-stream"
}

// SharedPrefix is the path prefix that serves the shared modules of extension points.
const SharedPrefix = "/shared/"

// InstalledShared returns the file that extends.<point>.modules of the plugin.json of the enabled installed plugin maps
// the specifier of /shared/<plugin id>.<point>/<specifier>.js to. The path ends in .js because the webview of the Tauri
// host takes the MIME type of a module from its path. shared is false for another path. found is false for a path
// without .js, a point that the plugin does not declare, a specifier that the point does not map, a missing file and
// a path outside the package.
func InstalledShared(configDir, urlPath string) (file string, shared, found bool, err error) {
	rest, ok := strings.CutPrefix(urlPath, SharedPrefix)
	if !ok {
		return "", false, false, nil
	}
	key, file, ok := strings.Cut(rest, "/")
	id, point, dotted := strings.Cut(key, ".")
	specifier, module := strings.CutSuffix(file, ".js")
	if !ok || !dotted || !module || specifier == "" {
		return "", true, false, nil
	}
	plugins, _, err := enabledPlugins(configDir)
	if err != nil {
		return "", true, false, err
	}
	index := slices.IndexFunc(plugins, func(plugin installedPlugin) bool { return plugin.id == id })
	if index < 0 {
		return "", true, false, nil
	}
	manifestFile := filepath.Join(plugins[index].dir, "plugin.json")
	data, err := os.ReadFile(manifestFile)
	if err != nil {
		return "", true, false, err
	}
	var manifest struct {
		Extends map[string]struct {
			Modules map[string]string `json:"modules"`
		} `json:"extends"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return "", true, false, fmt.Errorf("%s: %w", manifestFile, err)
	}
	target, ok := manifest.Extends[point].Modules[specifier]
	if !ok {
		return "", true, false, nil
	}
	file, found = insidePackage(plugins[index].dir, strings.Split(target, "/"))
	return file, true, found, nil
}

// InstalledAssets is the asset server middleware that serves the installed plugins. The next handler serves other paths.
func InstalledAssets(configDir string) application.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == InstalledPluginsPath {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "no-store")
				if _, err := w.Write(InstalledPluginsDocument(configDir, diagnosticPlugins)); err != nil {
					LogError(InstalledPluginsPath, err)
				}
				return
			}
			lookup := InstalledModule
			if strings.HasPrefix(r.URL.Path, SharedPrefix) {
				lookup = InstalledShared
			}
			file, installed, found, err := lookup(configDir, r.URL.Path)
			if err != nil {
				LogError(r.URL.Path, err)
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if !installed {
				next.ServeHTTP(w, r)
				return
			}
			if !found {
				http.NotFound(w, r)
				return
			}
			data, err := os.ReadFile(file)
			if err != nil {
				LogError(r.URL.Path, err)
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			kind := mime.TypeByExtension(filepath.Ext(file))
			if filepath.Ext(file) == ".js" || filepath.Ext(file) == ".mjs" {
				kind = "text/javascript"
			}
			if kind != "" {
				w.Header().Set("Content-Type", kind)
			}
			w.Header().Set("Cache-Control", "no-store")
			if _, err := w.Write(data); err != nil {
				LogError(r.URL.Path, err)
			}
		})
	}
}

// InstalledSidecars returns the sidecars that the plugin.json dependencies of the enabled installed plugins specify, together with the folder that the installation recorded.
// A dependency that names the package of an installed plugin is not a sidecar.
func InstalledSidecars(configDir string) ([]SidecarDeclaration, error) {
	plugins, state, err := enabledPlugins(configDir)
	if err != nil {
		return nil, err
	}
	var declarations []SidecarDeclaration
	declaredAt := map[string]int{}
	// The package of an installed plugin is a plugin dependency, so it is not declared as a sidecar.
	seen := map[string]bool{}
	for _, plugin := range state.Plugins {
		name, err := sok.InstalledName(configDir, plugin)
		if err != nil {
			return nil, err
		}
		seen[name] = true
	}
	for _, plugin := range plugins {
		file := filepath.Join(plugin.dir, "plugin.json")
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		var manifest struct {
			Dependencies map[string]string `json:"dependencies"`
		}
		if err := json.Unmarshal(data, &manifest); err != nil {
			return nil, fmt.Errorf("%s: %w", file, err)
		}
		// Reads in the order of names so that both hosts declare the sidecars in the same order.
		for _, name := range slices.Sorted(maps.Keys(manifest.Dependencies)) {
			if seen[name] {
				continue
			}
			// A sidecar that several plugins list is declared once, and each of them is one of its dependents.
			if index, ok := declaredAt[name]; ok {
				declarations[index].Dependents = append(declarations[index].Dependents, plugin.id)
				continue
			}
			sidecar, ok := state.Sidecars[name]
			if !ok {
				return nil, fmt.Errorf("%s: sidecar %s has no installed version", file, name)
			}
			folder := filepath.Join(configDir, sidecar.Path)
			declaration, err := os.ReadFile(filepath.Join(folder, "sidecar.json"))
			if err != nil {
				return nil, err
			}
			declaredAt[name] = len(declarations)
			declarations = append(declarations, SidecarDeclaration{Name: name, Folder: folder, Data: declaration, Version: sidecar.Version, Dependents: []string{plugin.id}})
		}
	}
	return declarations, nil
}

// ApplyPluginEventClasses gives the writer the classes that the catalogs of the enabled installed plugins declare, and records
// each catalog that it cannot use as an error of the place plugin catalog (docs/spec/logging.md#plugin-catalogs). The host
// applies it when it starts and after each change of the installed plugins.
func ApplyPluginEventClasses(log *EventLog, configDir string) {
	classes, errs := sok.PluginEventClasses(configDir)
	log.SetPluginClasses(classes)
	for _, err := range errs {
		LogError("plugin catalog", err)
	}
}
