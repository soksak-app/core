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
func configDirOf(values map[string]string, identifier string) (string, error) {
	if dir, ok := values["config-dir"]; ok {
		return dir, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("the default configuration directory is unknown: %w", err)
	}
	return filepath.Join(base, identifier), nil
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

// readIndexAt 은 경로나 `file:` URL 의 registry index 를 읽고 검사한다.
func readIndexAt(location string) (*Index, string, error) {
	path := location
	if strings.HasPrefix(location, "file:") {
		var err error
		if path, err = FilePath(location); err != nil {
			return nil, "", err
		}
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", fileError(path, err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, "", fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	index, err := ValidateRegistryIndex(value)
	if err != nil {
		return nil, "", fmt.Errorf("%s: %w", path, err)
	}
	return index, fileURL(path), nil
}

// UseRegistry 는 registry index 를 검사하고 그 주소를 plugins/registry.json 에 쓴다.
func UseRegistry(configDir, location string) (string, error) {
	_, url, err := readIndexAt(location)
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
	index, _, err := readIndexAt(url)
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
		return "", true, fmt.Errorf("%s: index must be an absolute file: URL", RegistryFile)
	}
	if _, err := FilePath(url); err != nil {
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
	installed, err := readInstalled(configDir)
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
		if index, _, err := readIndexAt(url); err != nil {
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

// readInstalled 는 plugins/installed.json 을 읽는다. 파일이 없으면 아무것도 설치하지 않은 상태다.
func readInstalled(configDir string) (*InstalledState, error) {
	path := filepath.Join(configDir, Installed)
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return &InstalledState{Format: InstallFormat, Plugins: map[string]InstalledPlugin{}, Sidecars: map[string]InstalledSidecar{}}, nil
	}
	if err != nil {
		return nil, fileError(path, err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	return ValidateInstalled(value)
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
			_, err = io.Copy(file, reader)
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

// InstallPlugin 은 plugin 의 고른 version 을 설치한다. update 가 참이면 설치된 plugin 만 받는다.
func InstallPlugin(configDir, id, core, platform string, update bool) (map[string]any, error) {
	index, err := readRegistry(configDir)
	if err != nil {
		return nil, err
	}
	state, err := readInstalled(configDir)
	if err != nil {
		return nil, err
	}
	current, installed := state.Plugins[id]
	if update && !installed {
		return nil, fmt.Errorf("plugin %s is not installed", id)
	}
	selection, err := ResolveInstall(index, id, core, platform, state)
	if err != nil {
		return nil, err
	}
	version := selection.Version.Version
	if installed && current.Version == version {
		return pluginResult(state, id), nil
	}
	pluginPath, err := PluginInstallPath(id, version)
	if err != nil {
		return nil, err
	}
	pluginFolder := filepath.Join(configDir, pluginPath)
	if err := installArchive("plugin "+id+" "+version+" package", selection.Version.Package, pluginFolder); err != nil {
		return nil, err
	}
	sidecarFolders := map[string]string{}
	for _, sidecar := range selection.Sidecars {
		path, err := SidecarInstallPath(sidecar.Name, sidecar.Version, platform)
		if err != nil {
			return nil, err
		}
		folder := filepath.Join(configDir, path)
		if err := installArchive("sidecar "+sidecar.Name+" "+sidecar.Version+" "+platform, sidecar.Asset, folder); err != nil {
			return nil, err
		}
		sidecarFolders[sidecar.Name] = folder
	}
	entry := InstalledPlugin{Package: selection.Plugin.Package, Version: version, Path: pluginFolder, Enabled: true, Sidecars: maps.Clone(selection.Version.Sidecars)}
	if installed {
		entry.Enabled = current.Enabled
		entry.Previous = current.Version
	}
	state.Plugins[id] = entry
	for _, sidecar := range selection.Sidecars {
		state.Sidecars[sidecar.Name] = InstalledSidecar{Version: sidecar.Version, Path: sidecarFolders[sidecar.Name]}
	}
	dropUnnamedSidecars(state)
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
	state, err := readInstalled(configDir)
	if err != nil {
		return nil, err
	}
	plugin, installed := state.Plugins[id]
	if !installed {
		return nil, fmt.Errorf("plugin %s is not installed", id)
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
	configDir, err := configDirOf(a.values, options.Identifier)
	if err != nil {
		return err
	}
	// 설치 상태는 절대 폴더를 기록하므로 설정 폴더도 절대 경로로 쓴다.
	if configDir, err = filepath.Abs(configDir); err != nil {
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
		url, err := UseRegistry(configDir, a.positionals[2])
		if err != nil {
			return err
		}
		result = map[string]string{"index": url}
	case "plugin list":
		state, err := readInstalled(configDir)
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
