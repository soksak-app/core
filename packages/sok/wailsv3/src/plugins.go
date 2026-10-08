package sok

// 설정 폴더에 plugin 을 설치하고 바꾼다(docs/spec/cli.md, docs/spec/installation.md). archive 는 임시 폴더에 푼 뒤
// 이름을 바꿔 제자리에 두고, installed.json 은 마지막에 한 번에 바꾸므로 실패한 설치는 이전 설치를 바꾸지 않는다.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// RegistryFile 은 설정 폴더 안에서 설치가 읽는 registry index 의 주소를 담는 파일이다.
const RegistryFile = "plugins/registry.json"

// configDirOf 는 --config-dir 이나 이 애플리케이션의 설정 폴더다.
func configDirOf(values map[string]string, options Options) (string, error) {
	if dir, ok := values["config-dir"]; ok {
		return dir, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("the default configuration directory is unknown: %w", err)
	}
	return filepath.Join(base, options.Identifier), nil
}

// fileURL 은 절대 경로의 `file:` URL 이다. 경로 문자 중 URL 에서 뜻을 가진 문자와 공백은 %XX 로 쓴다.
func fileURL(path string) string {
	var out strings.Builder
	out.WriteString("file://")
	for _, b := range []byte(path) {
		if b == '%' || b == '?' || b == '#' || b <= ' ' || b >= 0x7f {
			fmt.Fprintf(&out, "%%%02X", b)
		} else {
			out.WriteByte(b)
		}
	}
	return out.String()
}

// ReadIndexAt 은 경로, `file:` URL, `https:` URL 의 registry index 를 읽고 검사한다. 경로는 그 절대 `file:` URL 이
// 된다. 돌려주는 주소는 읽은 index 의 URL 이다.
func ReadIndexAt(location string, fetcher Fetcher) (*Index, string, error) {
	url := location
	if !strings.Contains(location, ":") {
		path, err := filepath.Abs(location)
		if err != nil {
			return nil, "", err
		}
		url = fileURL(path)
	}
	data, err := fetcher.Read(url, fetcher.Index)
	if err != nil {
		return nil, "", err
	}
	// 오류는 file: 이면 경로를, https: 면 URL 을 밝힌다.
	shown := url
	if path, err := FilePath(url); err == nil {
		shown = path
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, "", fmt.Errorf("%s is not valid JSON: %w", shown, err)
	}
	index, err := ValidateRegistryIndex(value)
	if err != nil {
		return nil, "", fmt.Errorf("%s: %w", shown, err)
	}
	return index, url, nil
}

// UseRegistry 는 registry index 를 검사하고 그 주소를 plugins/registry.json 에 쓴다.
func UseRegistry(configDir, location string, fetcher Fetcher) (string, error) {
	_, url, err := ReadIndexAt(location, fetcher)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(map[string]any{"format": InstallFormat, "index": url})
	if err != nil {
		return "", err
	}
	path := filepath.Join(configDir, RegistryFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fileError(filepath.Dir(path), err)
	}
	if err := replaceFile(path, append(data, '\n')); err != nil {
		return "", err
	}
	return url, nil
}

// readRegistry 는 plugins/registry.json 이 지정한 index 를 읽는다.
func readRegistry(configDir string) (*Index, error) {
	url, exists, err := readRegistryURL(configDir)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, fmt.Errorf("%s does not exist; run sok registry use <index.json>", filepath.Join(configDir, RegistryFile))
	}
	index, _, err := ReadIndexAt(url, DefaultFetcher)
	return index, err
}

// readRegistryURL 은 plugins/registry.json 의 index 주소를 읽는다. 파일이 없으면 exists 가 false 다.
func readRegistryURL(configDir string) (url string, exists bool, err error) {
	path := filepath.Join(configDir, RegistryFile)
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", true, fileError(path, err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return "", true, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	m, err := object(RegistryFile, value)
	if err != nil {
		return "", true, err
	}
	if err := only(RegistryFile, m, "format", "index"); err != nil {
		return "", true, err
	}
	if !isOne(m["format"]) {
		return "", true, fmt.Errorf("%s: format must be %d", RegistryFile, InstallFormat)
	}
	url, ok := m["index"].(string)
	if !ok {
		return "", true, fmt.Errorf("%s: index must be an https: or absolute file: URL", RegistryFile)
	}
	if err := CheckLocation(url); err != nil {
		return "", true, fmt.Errorf("%s: %w", RegistryFile, err)
	}
	return url, true, nil
}

// PluginsState 는 애플리케이션이 plugin 목록에 쓰는 registry 와 설치 상태다
// (docs/spec/installation.md#plugin-operations-in-the-application).
type PluginsState struct {
	Registry  *string         `json:"registry"`
	Index     any             `json:"index"`
	Installed *InstalledState `json:"installed"`
	// FirstRun 은 plugins/installed.json 이 없으면 true 다. 애플리케이션은 이때 starter pack 을 설치한다.
	FirstRun bool `json:"firstRun"`
}

// ReadPluginsState 는 registry 주소, 검사한 index, 설치 상태를 읽는다. index 를 읽지 못하면
// 그 오류를 index 자리에 담고, 설치 상태를 읽지 못하면 실패한다.
func ReadPluginsState(configDir string) (*PluginsState, error) {
	installed, err := ReadInstalled(configDir)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(configDir, Installed)
	_, statErr := os.Stat(path)
	if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return nil, fileError(path, statErr)
	}
	state := &PluginsState{Installed: installed, FirstRun: statErr != nil}
	url, exists, err := readRegistryURL(configDir)
	switch {
	case err != nil:
		state.Index = map[string]string{"error": err.Error()}
	case exists:
		state.Registry = &url
		if index, _, err := ReadIndexAt(url, DefaultFetcher); err != nil {
			state.Index = map[string]string{"error": err.Error()}
		} else {
			state.Index = index
		}
	}
	return state, nil
}

// RunPluginAction 은 sok plugin <action> <id> 와 같은 작업을 실행하고 그 출력을 돌려준다.
// action 은 install, update, remove, enable, disable 중 하나다.
func RunPluginAction(configDir, action, id, core, platform string) (any, error) {
	switch action {
	case "install", "update":
		return InstallPlugin(configDir, id, core, platform, action == "update")
	case "remove", "enable", "disable":
		return ChangePlugin(configDir, id, action)
	default:
		return nil, fmt.Errorf("unknown plugin action %q", action)
	}
}

// ReadInstalled 는 plugins/installed.json 을 읽는다. 파일이 없으면 아무것도 설치하지 않은 상태다. 현재 형식이 아닌
// 파일은 오류다(docs/spec/installation.md).
func ReadInstalled(configDir string) (*InstalledState, error) {
	path := filepath.Join(configDir, Installed)
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return &InstalledState{Format: InstalledFormat, Plugins: map[string]InstalledPlugin{}, Sidecars: map[string]InstalledSidecar{}}, nil
	}
	if err != nil {
		return nil, fileError(path, err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	state, err := ValidateInstalled(value)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return state, nil
}

// writeInstalled 는 installed.json 을 한 번에 바꾼다.
func writeInstalled(configDir string, state *InstalledState) error {
	var out bytes.Buffer
	if err := printJSON(&out, state); err != nil {
		return err
	}
	path := filepath.Join(configDir, Installed)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fileError(filepath.Dir(path), err)
	}
	return replaceFile(path, out.Bytes())
}

// extract 는 tar.gz archive 를 target 옆 임시 폴더에 푼 뒤 이름을 바꿔 target 에 둔다. 일반 파일과 폴더만 받고,
// 절대 경로와 `..` 는 거부한다.
func extract(data []byte, target string) (err error) {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fileError(filepath.Dir(target), err)
	}
	temp, err := os.MkdirTemp(filepath.Dir(target), "."+filepath.Base(target)+".*")
	if err != nil {
		return fileError(filepath.Dir(target), err)
	}
	defer func() {
		if err != nil {
			err = withCleanup(err, temp, os.RemoveAll)
		}
	}()
	zipped, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	reader := tar.NewReader(zipped)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(header.Name, "/")
		if name == "" || strings.HasPrefix(name, "/") || slices.Contains(strings.Split(name, "/"), "..") {
			return fmt.Errorf("archive entry %s leaves the folder", header.Name)
		}
		path := filepath.Join(temp, filepath.FromSlash(name))
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(path, 0o755); err != nil {
				return fileError(path, err)
			}
		case tar.TypeReg:
			mode := os.FileMode(0o644)
			if header.Mode&0o111 != 0 {
				mode = 0o755
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return fileError(filepath.Dir(path), err)
			}
			file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				return fileError(path, err)
			}
			// 만들 때의 mode 는 프로세스의 umask 가 좁히므로 명세의 mode 를 따로 정한다.
			err = file.Chmod(mode)
			if err == nil {
				_, err = io.Copy(file, reader)
			}
			if closeErr := file.Close(); err == nil {
				err = closeErr
			}
			if err != nil {
				return fileError(path, err)
			}
		default:
			return fmt.Errorf("archive entry %s is neither a regular file nor a folder", header.Name)
		}
	}
	if err := os.Rename(temp, target); err != nil {
		return fileError(target, err)
	}
	return nil
}

// installArchive 는 아직 없는 version 폴더에 archive 를 확인해 푼다.
func installArchive(where string, archive Archive, target string) error {
	if _, err := os.Stat(target); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fileError(where, err)
	}
	data, err := readArchive(where, archive)
	if err != nil {
		return err
	}
	if err := extract(data, target); err != nil {
		return fmt.Errorf("%s: %w", where, err)
	}
	return nil
}

// pluginResult 는 plugin 명령의 출력이다.
func pluginResult(state *InstalledState, id string) map[string]any {
	plugin := state.Plugins[id]
	sidecars := map[string]string{}
	for name := range plugin.Sidecars {
		sidecars[name] = state.Sidecars[name].Version
	}
	return map[string]any{"plugin": plugin, "sidecars": sidecars}
}

// InstallPlugin installs the selected version of a plugin and its plugin dependencies. With update it accepts only an
// installed plugin. It reads the plugin.json of every selected plugin version and completes the plan before it extracts
// an archive.
func InstallPlugin(configDir, id, core, platform string, update bool) (map[string]any, error) {
	index, err := readRegistry(configDir)
	if err != nil {
		return nil, err
	}
	state, err := ReadInstalled(configDir)
	if err != nil {
		return nil, err
	}
	if _, installed := state.Plugins[id]; update && !installed {
		return nil, fmt.Errorf("plugin %s is not installed", id)
	}
	plan := &dependencyPlan{configDir: configDir, core: core, platform: platform, index: index, state: state,
		dependencies: map[string]map[string]string{}, providers: map[string]map[string]string{}, archives: map[string][]byte{},
		sidecars: map[string]SelectedSidecar{}, placed: map[string]bool{}}
	if err := plan.place(id, false, nil); err != nil {
		return nil, err
	}
	if !plan.changed {
		return pluginResult(state, id), nil
	}
	for _, changed := range plan.order {
		data, ok := plan.archives[changed]
		if !ok {
			continue
		}
		plugin := state.Plugins[changed]
		if err := extract(data, filepath.Join(configDir, plugin.Path)); err != nil {
			return nil, fmt.Errorf("plugin %s %s package: %w", changed, plugin.Version, err)
		}
	}
	dropUnnamedSidecars(state)
	for _, name := range sortedNames(plan.selectedSidecars()) {
		sidecar := plan.sidecars[name]
		installed, ok := state.Sidecars[name]
		if !ok || installed.Version != sidecar.Version {
			continue
		}
		if err := installArchive("sidecar "+sidecar.Name+" "+sidecar.Version+" "+platform, sidecar.Asset, filepath.Join(configDir, installed.Path)); err != nil {
			return nil, err
		}
	}
	value, err := stateValue(state)
	if err != nil {
		return nil, err
	}
	if _, err := ValidateInstalled(value); err != nil {
		return nil, err
	}
	if err := writeInstalled(configDir, state); err != nil {
		return nil, err
	}
	if err := pruneFolders(configDir, state); err != nil {
		return nil, err
	}
	return pluginResult(state, id), nil
}

// dependencyPlan is the plan that installs a plugin and its plugin dependencies. state is the planned installation
// state; dependencies holds the plugin.json dependencies of the version in use of each plugin of state; providers holds
// the plugin dependencies of the versions that the plan selected; archives holds the archives of plugin versions that
// are not extracted yet; order lists the plugins whose version changed in selection order; sidecars holds the sidecar
// versions that the plan selected.
type dependencyPlan struct {
	configDir, core, platform string
	index                     *Index
	state                     *InstalledState
	dependencies              map[string]map[string]string
	providers                 map[string]map[string]string
	archives                  map[string][]byte
	order                     []string
	sidecars                  map[string]SelectedSidecar
	placed                    map[string]bool
	changed                   bool
}

// selectedSidecars is the version of each sidecar that the plan selected.
func (p *dependencyPlan) selectedSidecars() map[string]string {
	versions := map[string]string{}
	for name, sidecar := range p.sidecars {
		versions[name] = sidecar.Version
	}
	return versions
}

// manifestDependenciesOf checks and returns the dependencies of a plugin.json text. file is the location for errors.
func manifestDependenciesOf(file string, data []byte) (map[string]string, error) {
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", file, err)
	}
	manifest, err := object(file, value)
	if err != nil {
		return nil, err
	}
	dependencies, err := ManifestDependencies(manifest)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	return dependencies, nil
}

// installedDependencies reads the plugin.json dependencies from the recorded folder of an installed plugin.
func installedDependencies(configDir string, plugin InstalledPlugin) (map[string]string, error) {
	file := filepath.Join(configDir, plugin.Path, "plugin.json")
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, fileError(file, err)
	}
	return manifestDependenciesOf(file, data)
}

// manifest is the plugin.json dependencies of the version in use of a planned plugin.
func (p *dependencyPlan) manifest(id string) (map[string]string, error) {
	if dependencies, ok := p.dependencies[id]; ok {
		return dependencies, nil
	}
	dependencies, err := installedDependencies(p.configDir, p.state.Plugins[id])
	if err != nil {
		return nil, err
	}
	p.dependencies[id] = dependencies
	return dependencies, nil
}

// needs is the range of each planned plugin that names the package. The range of id itself is left out.
func (p *dependencyPlan) needs(id, pkg string) ([]Need, error) {
	var needs []Need
	for _, other := range sortedPluginIDs(p.state.Plugins) {
		if other == id {
			continue
		}
		dependencies, err := p.manifest(other)
		if err != nil {
			return nil, err
		}
		if rng, ok := dependencies[pkg]; ok {
			needs = append(needs, Need{other + " " + p.state.Plugins[other].Version, rng})
		}
	}
	return needs, nil
}

// place adds plugin id to the plan and then each of its plugin dependencies. A provider is a plugin that another plugin
// names as a dependency: its installed version is kept when it satisfies every range, and it is enabled when it is
// disabled. path lists the plugin ids that the dependencies were followed through.
func (p *dependencyPlan) place(id string, provider bool, path []string) error {
	if i := slices.Index(path, id); i >= 0 {
		return fmt.Errorf("plugin dependency cycle: %s", strings.Join(append(slices.Clone(path[i:]), id), " -> "))
	}
	current, installed := p.state.Plugins[id]
	pkg := current.Package
	if i := slices.IndexFunc(p.index.Plugins, func(entry RegistryPlugin) bool { return entry.ID == id }); i >= 0 {
		pkg = p.index.Plugins[i].Package
	}
	needs, err := p.needs(id, pkg)
	if err != nil {
		return err
	}
	satisfied := installed && !slices.ContainsFunc(needs, func(n Need) bool { return !Satisfies(current.Version, n.Range) })
	if p.placed[id] {
		// A version that the plan selected earlier must also satisfy the range of a dependent that was read later.
		if !satisfied {
			return fmt.Errorf("plugin %s has no version for core %s that satisfies every installed plugin: %s", id, p.core, needsText(needs))
		}
		return nil
	}
	p.placed[id] = true
	if !provider || !satisfied {
		selection, err := ResolveInstall(p.index, id, p.core, p.platform, p.state, needs)
		if err != nil {
			return err
		}
		if !installed || selection.Version.Version != current.Version {
			if err := p.replace(id, current, installed, selection); err != nil {
				return err
			}
		}
	}
	if plugin := p.state.Plugins[id]; provider && !plugin.Enabled {
		plugin.Enabled = true
		p.state.Plugins[id] = plugin
		p.changed = true
	}
	providers, ok := p.providers[id]
	if !ok {
		// The plugin dependencies of a plugin that the plan did not change are its dependencies without a recorded
		// sidecar range.
		dependencies, err := p.manifest(id)
		if err != nil {
			return err
		}
		providers = map[string]string{}
		for name, rng := range dependencies {
			if _, sidecar := p.state.Plugins[id].Sidecars[name]; !sidecar {
				providers[name] = rng
			}
		}
	}
	for _, name := range sortedNames(providers) {
		dependency := ""
		if i := slices.IndexFunc(p.index.Plugins, func(entry RegistryPlugin) bool { return entry.Package == name }); i >= 0 {
			dependency = p.index.Plugins[i].ID
		}
		for _, other := range sortedPluginIDs(p.state.Plugins) {
			if dependency == "" && p.state.Plugins[other].Package == name {
				dependency = other
			}
		}
		if dependency == "" {
			return fmt.Errorf("%s %s: dependency %s is neither a plugin nor a sidecar of the registry", id, p.state.Plugins[id].Version, name)
		}
		if err := p.place(dependency, true, append(slices.Clone(path), id)); err != nil {
			return err
		}
	}
	return nil
}

// replace adds the selected version of a plugin to the plan. It reads the plugin.json of that version from its
// extracted folder, or else from the archive after it checks the sha256, and keeps the archive for extraction after
// the plan is complete.
func (p *dependencyPlan) replace(id string, current InstalledPlugin, installed bool, selection *Selection) error {
	version := selection.Version.Version
	where := "plugin " + id + " " + version + " package"
	pluginPath, err := PluginInstallPath(id, version)
	if err != nil {
		return err
	}
	folder := filepath.Join(p.configDir, pluginPath)
	file := filepath.Join(folder, "plugin.json")
	var data []byte
	if _, err := os.Stat(folder); err == nil {
		if data, err = os.ReadFile(file); err != nil {
			return fileError(file, err)
		}
	} else if errors.Is(err, fs.ErrNotExist) {
		archive, err := readArchive(where, selection.Version.Package)
		if err != nil {
			return err
		}
		files, err := archiveFiles(archive, "plugin.json")
		if err != nil {
			return fmt.Errorf("%s: %w", where, err)
		}
		data, file = files["plugin.json"], where+": plugin.json"
		p.archives[id] = archive
	} else {
		return fileError(where, err)
	}
	dependencies, err := manifestDependenciesOf(file, data)
	if err != nil {
		return err
	}
	providers, _, err := ClassifyDependencies(p.index, id, version, dependencies)
	if err != nil {
		return err
	}
	p.dependencies[id], p.providers[id] = dependencies, providers
	entry := InstalledPlugin{Package: selection.Plugin.Package, Version: version, Path: pluginPath, Enabled: true, Sidecars: maps.Clone(selection.Version.Sidecars)}
	if installed {
		entry.Enabled = current.Enabled
		entry.Previous = current.Version
	}
	p.state.Plugins[id] = entry
	for _, sidecar := range selection.Sidecars {
		path, err := SidecarInstallPath(sidecar.Name, sidecar.Version, p.platform)
		if err != nil {
			return err
		}
		p.state.Sidecars[sidecar.Name] = InstalledSidecar{Version: sidecar.Version, Path: path}
		p.sidecars[sidecar.Name] = sidecar
	}
	p.order = append(p.order, id)
	p.changed = true
	return nil
}

// dropUnnamedSidecars 는 어느 plugin 도 지정하지 않은 sidecar 를 지운다.
func dropUnnamedSidecars(state *InstalledState) {
	for name := range state.Sidecars {
		named := false
		for _, plugin := range state.Plugins {
			_, uses := plugin.Sidecars[name]
			named = named || uses
		}
		if !named {
			delete(state.Sidecars, name)
		}
	}
}

// stateValue 는 설치 상태를 형식 검사에 쓰는 값으로 바꾼다.
func stateValue(state *InstalledState) (any, error) {
	data, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	return DecodeJSON(data)
}

// pruneFolders 는 설치된 plugin 의 쓰는 version 과 previous 가 아닌 plugin 폴더와 version 폴더, installed.json 이
// 지정하지 않은 sidecar 폴더와 version 폴더를 지운다. 지우지 못한 폴더를 모두 보고한다.
func pruneFolders(configDir string, state *InstalledState) error {
	var failures []error
	remove := func(path string) {
		if err := os.RemoveAll(path); err != nil {
			failures = append(failures, fmt.Errorf("cannot delete %s: %w", path, err))
		}
	}
	plugins := filepath.Join(configDir, "plugins")
	ids, err := os.ReadDir(plugins)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fileError(plugins, err)
	}
	for _, folder := range ids {
		if !folder.IsDir() {
			continue
		}
		plugin, installed := state.Plugins[folder.Name()]
		if !installed {
			remove(filepath.Join(plugins, folder.Name()))
			continue
		}
		versions, err := os.ReadDir(filepath.Join(plugins, folder.Name()))
		if err != nil {
			failures = append(failures, fileError(filepath.Join(plugins, folder.Name()), err))
			continue
		}
		for _, version := range versions {
			if version.Name() != plugin.Version && version.Name() != plugin.Previous {
				remove(filepath.Join(plugins, folder.Name(), version.Name()))
			}
		}
	}
	kept := map[string]string{}
	for name, sidecar := range state.Sidecars {
		file, err := SidecarFileName(name)
		if err != nil {
			return err
		}
		kept[file] = sidecar.Version
	}
	sidecars := filepath.Join(configDir, "sidecars")
	files, err := os.ReadDir(sidecars)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fileError(sidecars, err)
	}
	for _, folder := range files {
		version, used := kept[folder.Name()]
		if !used {
			remove(filepath.Join(sidecars, folder.Name()))
			continue
		}
		versions, err := os.ReadDir(filepath.Join(sidecars, folder.Name()))
		if err != nil {
			failures = append(failures, fileError(filepath.Join(sidecars, folder.Name()), err))
			continue
		}
		for _, item := range versions {
			if item.Name() != version {
				remove(filepath.Join(sidecars, folder.Name(), item.Name()))
			}
		}
	}
	return errors.Join(failures...)
}

// ChangePlugin 은 설치된 plugin 을 지우거나 켜고 끈다.
func ChangePlugin(configDir, id, action string) (any, error) {
	state, err := ReadInstalled(configDir)
	if err != nil {
		return nil, err
	}
	plugin, installed := state.Plugins[id]
	if !installed {
		return nil, fmt.Errorf("plugin %s is not installed", id)
	}
	if action == "remove" || action == "disable" {
		// A plugin whose package another enabled plugin names as a dependency is neither removed nor disabled.
		for _, other := range sortedPluginIDs(state.Plugins) {
			dependent := state.Plugins[other]
			if other == id || !dependent.Enabled {
				continue
			}
			dependencies, err := installedDependencies(configDir, dependent)
			if err != nil {
				return nil, err
			}
			if rng, ok := dependencies[plugin.Package]; ok {
				return nil, fmt.Errorf("plugin %s is required by %s %s", id, other, rng)
			}
		}
	}
	switch action {
	case "remove":
		delete(state.Plugins, id)
		dropUnnamedSidecars(state)
	case "enable", "disable":
		plugin.Enabled = action == "enable"
		state.Plugins[id] = plugin
	}
	if err := writeInstalled(configDir, state); err != nil {
		return nil, err
	}
	if action == "remove" {
		if err := pruneFolders(configDir, state); err != nil {
			return nil, err
		}
		return nil, nil
	}
	return state.Plugins[id], nil
}

// runPlugins 는 registry use 와 plugin install, update, remove, enable, disable, list 를 실행한다.
func runPlugins(a arguments, stdout io.Writer, options Options) error {
	configDir, err := configDirOf(a.values, options)
	if err != nil {
		return err
	}
	command := a.positionals[0] + " " + a.positionals[1]
	want := 3
	if command == "plugin list" {
		want = 2
	}
	if len(a.positionals) < want {
		return usage("%s needs an argument", command)
	}
	if len(a.positionals) > want {
		return usage("unexpected argument %s", a.positionals[want])
	}
	var result any
	switch command {
	case "registry use":
		url, err := UseRegistry(configDir, a.positionals[2], DefaultFetcher)
		if err != nil {
			return err
		}
		result = map[string]string{"index": url}
	case "plugin list":
		state, err := ReadInstalled(configDir)
		if err != nil {
			return err
		}
		result = state
	case "plugin install", "plugin update", "plugin remove", "plugin enable", "plugin disable":
		// platform 은 버전을 고르는 install 과 update 에만 필요하다.
		platform := ""
		if action := a.positionals[1]; action == "install" || action == "update" {
			if platform, err = CurrentPlatform(); err != nil {
				return err
			}
		}
		if result, err = RunPluginAction(configDir, a.positionals[1], a.positionals[2], options.CoreVersion, platform); err != nil {
			return err
		}
	default:
		return usage("unknown command: %s", command)
	}
	return printJSON(stdout, result)
}
