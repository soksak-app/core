package host

// 설정 폴더에 설치된 plugin 을 페이지에 제공하고 그 sidecar 를 찾는다(docs/spec/installation.md 의 설치된 plugin
// 제공). 파일은 설치가 installed.json 에 기록한 폴더에서만 읽는다. 설치 상태는 요청마다 읽으므로 변경 뒤에 불러온
// 페이지는 그 변경을 본다. 형식 검사는 command line sok 의 구현을 쓴다.

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

// diagnosticPlugins 는 진단 build 에서 참이다. diagnostics.go 의 init 이 켜며, 참이면 /installed-plugins.json 이
// 설치된 package 의 diagnostics.json 을 담는다.
var diagnosticPlugins bool

// InstalledPluginsPath 는 페이지가 설치된 plugin 목록을 읽는 경로다.
const InstalledPluginsPath = "/installed-plugins.json"

// installedPlugin 은 켜진 설치 plugin 하나와 그 파일 폴더다.
type installedPlugin struct {
	id, pkg, version, dir string
}

// enabledPlugins 는 켜진 설치 plugin 을 id 순서로 돌려준다. 설치 폴더는 설정 폴더에 대한 상대 경로로 기록되며, 형식
// 1 파일의 변환 보고는 애플리케이션 로그인 표준 오류에 쓴다(docs/spec/installation.md).
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
		plugins = append(plugins, installedPlugin{id: id, pkg: plugin.Package, version: plugin.Version, dir: filepath.Join(configDir, plugin.Path)})
	}
	slices.SortFunc(plugins, func(a, b installedPlugin) int { return strings.Compare(a.id, b.id) })
	return plugins, state, nil
}

// PackageFolder returns the folder of the enabled installed plugin, which the document regions of its surfaces serve
// at soksak-package://<plugin>/ (docs/spec/native-surfaces.md#document-regions).
func PackageFolder(configDir, plugin string) (string, error) {
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

// InstalledPluginsDocument 는 /installed-plugins.json 의 내용이다. plugin 마다 설치된 plugin.json 을 manifest 로 담아
// page 가 첫 화면 전에 plugin 을 등록하게 한다. 설치 상태를 읽을 수 없으면 { "error" } 문서다.
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
				// 기본값: diagnostics.json 이 없는 plugin 은 진단 선언이 없다.
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

// InstalledModule 은 /modules/<package>/<path> 가 켜진 설치 plugin 의 파일이면 그 경로를 돌려준다. installed 가
// 거짓이면 그 package 는 애플리케이션 frontend 의 것이다. 경로가 틀리면 found 가 거짓이다.
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

// InstalledAssets 는 설치된 plugin 을 제공하는 asset server middleware 다. 다른 경로는 다음 handler 가 제공한다.
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

// InstalledSidecars 는 켜진 설치 plugin 의 plugin.json dependencies 가 지정한 sidecar 를 설치가 기록한 폴더와 함께 돌려준다.
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
		seen[plugin.Package] = true
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
		// 두 host 가 같은 순서로 사이드카를 선언하도록 이름 순서로 읽는다.
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
			declarations = append(declarations, SidecarDeclaration{Name: name, Folder: folder, Data: declaration})
		}
	}
	return declarations, nil
}
