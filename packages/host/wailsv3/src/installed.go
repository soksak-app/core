package host

// Provides the plugins installed in the configuration folder to the page and finds their sidecars (the section on providing installed plugins of docs/spec/installation.md). A file is read only from
// the folder that the installation recorded in installed.json. The install state is read for every request, so a page loaded after a change sees that change.
// The format check uses the implementation of the command line sok.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

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
}

// enabledPlugins returns the enabled installed plugins in the order of their ids. The install folder is recorded as a path relative to the configuration folder, and the conversion report of
// a format 1 file is written to the standard error, which is the application log (docs/spec/installation.md).
func enabledPlugins(configDir string) ([]installedPlugin, *sok.InstalledState, error) {
	state, err := sok.ReadInstalled(configDir)
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
		plugins = append(plugins, installedPlugin{id: id, pkg: name, version: plugin.Version, dir: filepath.Join(configDir, plugin.Path)})
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
		manifestFile := filepath.Join(plugin.dir, "plugin.json")
		manifest, err := os.ReadFile(manifestFile)
		switch {
		case errors.Is(err, os.ErrNotExist):
			return failure(fmt.Errorf("%s: the plugin manifest is missing", manifestFile))
		case err != nil:
			return failure(err)
		case !json.Valid(manifest):
			return failure(fmt.Errorf("%s is not valid JSON", manifestFile))
		}
		var compactManifest bytes.Buffer
		if err := json.Compact(&compactManifest, manifest); err != nil {
			return failure(err)
		}
		item := entry{ID: plugin.id, Package: plugin.pkg, Version: plugin.version, Manifest: compactManifest.Bytes()}
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
			seen[name] = true
			sidecar, ok := state.Sidecars[name]
			if !ok {
				return nil, fmt.Errorf("%s: sidecar %s has no installed version", file, name)
			}
			folder := filepath.Join(configDir, sidecar.Path)
			declaration, err := os.ReadFile(filepath.Join(folder, "sidecar.json"))
			if err != nil {
				return nil, err
			}
			declarations = append(declarations, SidecarDeclaration{Name: name, Folder: folder, Data: declaration, Version: sidecar.Version})
		}
	}
	return declarations, nil
}
