package sok

// Installs and changes plugins in the configuration directory (docs/spec/cli.md, docs/spec/installation.md). A release
// is extracted into a temporary folder and then moved into place by rename, and installed.json is replaced once at the
// end, so a failed installation does not change the earlier installation.

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

// RegistryFile is the file inside the configuration directory that holds the address of the registry index that
// installations read.
const RegistryFile = "plugins/registry.json"

// StarterJobFile stores the pending or completed first-run starter installation.
const StarterJobFile = "plugins/starter.json"

const StarterJobFormat = 1

// configDirOf is --config-dir or the configuration directory of this application.
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

// fileURL is the `file:` URL of an absolute path. Path characters that have a meaning in a URL, and spaces, are written
// as %XX.
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

// ReadIndexAt reads and checks the registry index at a path, a `file:` URL or an `https:` URL. A path becomes its
// absolute `file:` URL. The returned address is the URL of the index that was read.
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
	// For file: the error names the path, and for https: it names the URL.
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

// UseRegistry checks the registry index and writes its address to plugins/registry.json.
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

// readRegistry reads the index that plugins/registry.json designates.
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

// readRegistryURL reads the index address of plugins/registry.json. When the file does not exist, exists is false.
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

// PluginsState is the registry and the installation state that the application uses for its plugin list.
// (docs/spec/installation.md#plugin-operations-in-the-application).
type PluginsState struct {
	Registry  *string         `json:"registry"`
	Index     any             `json:"index"`
	Installed *InstalledState `json:"installed"`
	// FirstRun is true when plugins/installed.json does not exist. The application then installs the starter pack.
	FirstRun bool        `json:"firstRun"`
	Starter  *StarterJob `json:"starter"`
}

// StarterJob is the durable snapshot of a starter pack installation.
type StarterJob struct {
	Format   int      `json:"format"`
	State    string   `json:"state"`
	Pack     string   `json:"pack"`
	Registry string   `json:"registry"`
	Plugins  []string `json:"plugins"`
}

// StarterJobRequest is the requested state transition of pluginsStarter.
type StarterJobRequest struct {
	State    string   `json:"state"`
	Pack     string   `json:"pack"`
	Registry string   `json:"registry"`
	Plugins  []string `json:"plugins"`
}

// ReadPluginsState reads the registry address, the checked index and the installation state. When the index cannot be
// read, it holds that error in the index field, and when the installation state cannot be read, it fails.
func ReadPluginsState(configDir string) (*PluginsState, error) {
	installed, err := ReadInstalled(configDir)
	if err != nil {
		return nil, err
	}
	starter, err := ReadStarterJob(configDir)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(configDir, Installed)
	_, statErr := os.Stat(path)
	if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return nil, fileError(path, statErr)
	}
	state := &PluginsState{Installed: installed, FirstRun: statErr != nil, Starter: starter}
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

// ValidateStarterJob checks the current on-disk starter job form.
func ValidateStarterJob(value any) (*StarterJob, error) {
	root, err := object(StarterJobFile, value)
	if err != nil {
		return nil, err
	}
	if err := only(StarterJobFile, root, "format", "state", "pack", "registry", "plugins"); err != nil {
		return nil, err
	}
	if format, ok := root["format"].(json.Number); !ok || format.String() != "1" {
		return nil, fmt.Errorf("%s: format must be %d", StarterJobFile, StarterJobFormat)
	}
	state, ok := text(root["state"])
	if !ok || state != "pending" && state != "complete" {
		return nil, fmt.Errorf("%s state: must be pending or complete", StarterJobFile)
	}
	pack, ok := text(root["pack"])
	if !ok {
		return nil, fmt.Errorf("%s pack: must be a non-empty string", StarterJobFile)
	}
	registry, ok := text(root["registry"])
	if !ok {
		return nil, fmt.Errorf("%s registry: must be a non-empty URL", StarterJobFile)
	}
	if err := CheckLocation(registry); err != nil {
		return nil, fmt.Errorf("%s registry: %w", StarterJobFile, err)
	}
	values, err := array(StarterJobFile+" plugins", root["plugins"])
	if err != nil {
		return nil, err
	}
	plugins := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		id, ok := value.(string)
		if !ok || !isIdentifier(id) {
			return nil, fmt.Errorf("%s plugins: id must be a lowercase identifier", StarterJobFile)
		}
		if _, ok := seen[id]; ok {
			return nil, fmt.Errorf("%s plugins: duplicate id %s", StarterJobFile, id)
		}
		seen[id] = struct{}{}
		plugins = append(plugins, id)
	}
	return &StarterJob{Format: StarterJobFormat, State: state, Pack: pack, Registry: registry, Plugins: plugins}, nil
}

// ReadStarterJob reads the durable starter job. Absence means no pending or completed job.
func ReadStarterJob(configDir string) (*StarterJob, error) {
	path := filepath.Join(configDir, StarterJobFile)
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fileError(path, err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, fmt.Errorf("%s is not valid JSON", path)
	}
	job, err := ValidateStarterJob(value)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return job, nil
}

// WriteStarterJob creates a starter snapshot or completes that exact snapshot.
func WriteStarterJob(configDir string, request StarterJobRequest) (*StarterJob, error) {
	requestBytes, err := json.Marshal(map[string]any{"format": StarterJobFormat, "state": request.State, "pack": request.Pack, "registry": request.Registry, "plugins": request.Plugins})
	if err != nil {
		return nil, err
	}
	requestValue, err := DecodeJSON(requestBytes)
	if err != nil {
		return nil, err
	}
	requested, err := ValidateStarterJob(requestValue)
	if err != nil {
		return nil, err
	}
	registry, exists, err := readRegistryURL(configDir)
	if err != nil {
		return nil, err
	}
	if !exists || registry != requested.Registry {
		return nil, errors.New("starter job registry does not match the current registry")
	}
	existing, err := ReadStarterJob(configDir)
	if err != nil {
		return nil, err
	}
	installed, err := ReadInstalled(configDir)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(configDir, StarterJobFile)
	if existing == nil {
		if requested.State != "pending" {
			return nil, errors.New("starter job can only start as pending")
		}
		if _, err := os.Stat(filepath.Join(configDir, Installed)); err == nil {
			return nil, errors.New("starter job cannot start after plugin installation has begun")
		} else if !errors.Is(err, fs.ErrNotExist) {
			return nil, fileError(filepath.Join(configDir, Installed), err)
		}
	} else {
		if existing.Pack != requested.Pack || existing.Registry != requested.Registry || !slices.Equal(existing.Plugins, requested.Plugins) {
			return nil, errors.New("starter job request does not match the stored snapshot")
		}
		if existing.State == "complete" {
			if requested.State == "complete" {
				return existing, nil
			}
			return nil, errors.New("completed starter job cannot be reset")
		}
		if requested.State == "pending" {
			return existing, nil
		}
	}
	if requested.State == "complete" {
		for _, id := range requested.Plugins {
			if _, ok := installed.Plugins[id]; !ok {
				return nil, fmt.Errorf("starter job cannot complete: plugin %s is not installed", id)
			}
		}
	}
	var out bytes.Buffer
	if err := printJSON(&out, requested); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fileError(filepath.Dir(path), err)
	}
	if err := replaceFile(path, out.Bytes()); err != nil {
		return nil, err
	}
	return requested, nil
}

// RunPluginAction runs the same operation as sok plugin <action> <id> and returns its output. action is one of install,
// update, remove, enable and disable. The hosts call it inside their own ownership of the configuration directory, so
// it takes no lock; the command line entry owns the directory for the duration of the write
// (docs/spec/installation.md).
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

// InstalledManifest is the plugin.json of an installed plugin. ReadInstalledManifests reads and parses it once, and the
// dependency and document code use this value.
type InstalledManifest struct {
	// Compact is the plugin.json with the insignificant whitespace removed; the key order is kept.
	Compact []byte
	// Value is the parsed plugin.json.
	Value map[string]any
}

// ReadInstalled reads plugins/installed.json. The entry of the shared reader migrates the file to the current format
// first, so every reader in every process finds the current form (docs/spec/installation.md#stored-data-migration). When
// the file does not exist, nothing is installed. A file that is not in the current format is an error.
func ReadInstalled(configDir string) (*InstalledState, error) {
	state, _, err := ReadInstalledManifests(configDir)
	return state, err
}

// ReadInstalledManifests reads plugins/installed.json and the plugin.json of each installed plugin, each once. It
// returns the state and the manifest of each installed plugin by id.
func ReadInstalledManifests(configDir string) (*InstalledState, map[string]InstalledManifest, error) {
	if _, err := MigrateInstalled(configDir); err != nil {
		return nil, nil, err
	}
	path := filepath.Join(configDir, Installed)
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return &InstalledState{Format: InstalledFormat, Plugins: map[string]InstalledPlugin{}, Sidecars: map[string]InstalledSidecar{}}, map[string]InstalledManifest{}, nil
	}
	if err != nil {
		return nil, nil, fileError(path, err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, nil, fmt.Errorf("%s is not valid JSON", path)
	}
	state, err := ValidateInstalled(value)
	if err != nil {
		return nil, nil, fmt.Errorf("%s: %w", path, err)
	}
	manifests, err := readInstalledManifests(configDir, state)
	if err != nil {
		return nil, nil, err
	}
	return state, manifests, nil
}

// writeInstalled replaces installed.json in one step.
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

// extract extracts a tar.gz release into a temporary folder next to target and then moves it to target by rename. It
// accepts only regular files and folders and rejects absolute paths and `..`.
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
			return fmt.Errorf("release entry %s leaves the folder", header.Name)
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
			// The process umask narrows the mode given at creation, so the mode of the specification is set separately.
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
			return fmt.Errorf("release entry %s is neither a regular file nor a folder", header.Name)
		}
	}
	if err := os.Rename(temp, target); err != nil {
		return fileError(target, err)
	}
	return nil
}

// installRelease verifies the release and extracts it into a version folder that does not exist yet.
func installRelease(where string, release Release, target string) error {
	if _, err := os.Stat(target); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fileError(where, err)
	}
	data, err := readRelease(where, release)
	if err != nil {
		return err
	}
	if err := extract(data, target); err != nil {
		return fmt.Errorf("%s: %w", where, err)
	}
	return nil
}

// pluginResult is the output of a plugin command.
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
// an release.
func InstallPlugin(configDir, id, core, platform string, update bool) (map[string]any, error) {
	index, err := readRegistry(configDir)
	if err != nil {
		return nil, err
	}
	state, manifests, err := ReadInstalledManifests(configDir)
	if err != nil {
		return nil, err
	}
	if _, installed := state.Plugins[id]; update && !installed {
		return nil, fmt.Errorf("plugin %s is not installed", id)
	}
	plan := &dependencyPlan{configDir: configDir, core: core, platform: platform, index: index, state: state,
		manifests: manifests, dependencies: map[string]map[string]string{}, providers: map[string]map[string]string{},
		releases: map[string][]byte{}, sidecars: map[string]SelectedSidecar{}, placed: map[string]bool{}}
	if err := plan.place(id, false, nil); err != nil {
		return nil, err
	}
	if !plan.changed {
		return pluginResult(state, id), nil
	}
	for _, changed := range plan.order {
		data, ok := plan.releases[changed]
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
		if err := installRelease("sidecar "+sidecar.Name+" "+sidecar.Version+" "+platform, sidecar.Release, filepath.Join(configDir, installed.Path)); err != nil {
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
// the plugin dependencies of the versions that the plan selected; releases holds the releases of plugin versions that
// are not extracted yet; order lists the plugins whose version changed in selection order; sidecars holds the sidecar
// versions that the plan selected.
type dependencyPlan struct {
	configDir, core, platform string
	index                     *Index
	state                     *InstalledState
	manifests                 map[string]InstalledManifest
	dependencies              map[string]map[string]string
	providers                 map[string]map[string]string
	releases                  map[string][]byte
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

// manifestFile is the plugin.json in the recorded folder of an installed plugin.
func manifestFile(configDir string, plugin InstalledPlugin) string {
	return filepath.Join(configDir, plugin.Path, "plugin.json")
}

// readInstalledManifests reads and checks the plugin.json of each installed plugin in its recorded folder, once each.
func readInstalledManifests(configDir string, state *InstalledState) (map[string]InstalledManifest, error) {
	manifests := map[string]InstalledManifest{}
	for _, id := range sortedPluginIDs(state.Plugins) {
		file := manifestFile(configDir, state.Plugins[id])
		data, err := os.ReadFile(file)
		switch {
		case errors.Is(err, os.ErrNotExist):
			return nil, fmt.Errorf("%s: the plugin manifest is missing", file)
		case err != nil:
			return nil, fileError(file, err)
		}
		manifest, err := parseManifest(file, data)
		if err != nil {
			return nil, err
		}
		if err := checkPluginID(id, file, manifest); err != nil {
			return nil, err
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, data); err != nil {
			return nil, fmt.Errorf("%s is not valid JSON", file)
		}
		manifests[id] = InstalledManifest{Compact: compact.Bytes(), Value: manifest}
		if afterManifestRead != nil {
			afterManifestRead(file)
		}
	}
	return manifests, nil
}

// parseManifest parses a plugin.json text into an object. file is the location for errors. The error names only the
// file: the parser texts of encoding/json and serde_json differ, so a parser detail would make the hosts report
// different texts (docs/spec/host-contract.md#installed.plugin-json.invalid-text).
func parseManifest(file string, data []byte) (map[string]any, error) {
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, fmt.Errorf("%s is not valid JSON", file)
	}
	return object(file, value)
}

// checkPluginID checks that the plugin.json of plugin id names id. file is the location for errors.
func checkPluginID(id, file string, manifest map[string]any) error {
	if err := CheckPluginID(id, manifest); err != nil {
		return fmt.Errorf("%s: %w", file, err)
	}
	return nil
}

// afterManifestRead is the fault hook of the reader. It runs after checkInstalledPluginIDs reads and checks each
// plugin.json. Tests use it to change a file between two reads; nil means no hook.
var afterManifestRead func(file string)

// SetAfterManifestRead sets the fault hook that runs after ReadInstalled reads and checks each plugin.json. A nil
// hook removes it.
func SetAfterManifestRead(hook func(file string)) {
	afterManifestRead = hook
}

// manifestDependenciesOf checks and returns the dependencies of a parsed plugin.json. file is the location for errors.
func manifestDependenciesOf(file string, manifest map[string]any) (map[string]string, error) {
	dependencies, err := ManifestDependencies(manifest)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	return dependencies, nil
}

// InstalledName reads the name of the package.json in the recorded folder of an installed plugin.
func InstalledName(configDir string, plugin InstalledPlugin) (string, error) {
	file := filepath.Join(configDir, plugin.Path, "package.json")
	data, err := os.ReadFile(file)
	if err != nil {
		return "", fileError(file, err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return "", fmt.Errorf("%s is not valid JSON", file)
	}
	pkg, err := object("package.json", value)
	if err != nil {
		return "", fmt.Errorf("%s: %w", file, err)
	}
	if err := checkPackageJSONName("package.json name", pkg["name"]); err != nil {
		return "", fmt.Errorf("%s: %w", file, err)
	}
	return pkg["name"].(string), nil
}

// manifest is the plugin.json dependencies of the version in use of a planned plugin.
func (p *dependencyPlan) manifest(id string) (map[string]string, error) {
	if dependencies, ok := p.dependencies[id]; ok {
		return dependencies, nil
	}
	installed, ok := p.manifests[id]
	if !ok {
		return nil, fmt.Errorf("plugin %s has no installed manifest", id)
	}
	dependencies, err := manifestDependenciesOf(manifestFile(p.configDir, p.state.Plugins[id]), installed.Value)
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
	pkg := ""
	if i := slices.IndexFunc(p.index.Plugins, func(entry RegistryPlugin) bool { return entry.ID == id }); i >= 0 {
		pkg = p.index.Plugins[i].Package
	} else if installed {
		name, err := InstalledName(p.configDir, current)
		if err != nil {
			return err
		}
		pkg = name
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
			if dependency != "" {
				break
			}
			otherName, err := InstalledName(p.configDir, p.state.Plugins[other])
			if err != nil {
				return err
			}
			if otherName == name {
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
// extracted folder, or else from the release after it checks the sha256, and keeps the release for extraction after
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
		release, err := readRelease(where, selection.Version.Release)
		if err != nil {
			return err
		}
		files, err := releaseFiles(release, "plugin.json")
		if err != nil {
			return fmt.Errorf("%s: %w", where, err)
		}
		data, file = files["plugin.json"], where+": plugin.json"
		p.releases[id] = release
	} else {
		return fileError(where, err)
	}
	manifest, err := parseManifest(file, data)
	if err != nil {
		return err
	}
	if err := checkPluginID(id, file, manifest); err != nil {
		return err
	}
	if err := ValidateManifest(manifest); err != nil {
		return fmt.Errorf("%s: %w", file, err)
	}
	dependencies, err := manifestDependenciesOf(file, manifest)
	if err != nil {
		return err
	}
	providers, _, err := ClassifyDependencies(p.index, id, version, dependencies)
	if err != nil {
		return err
	}
	p.dependencies[id], p.providers[id] = dependencies, providers
	entry := InstalledPlugin{Version: version, Path: pluginPath, Enabled: true, Sidecars: maps.Clone(selection.Version.Sidecars)}
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

// dropUnnamedSidecars removes the sidecars that no plugin designates.
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

// stateValue turns the installation state into the value that the format check uses.
func stateValue(state *InstalledState) (any, error) {
	data, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	return DecodeJSON(data)
}

// pruneFolders removes the plugin folders and version folders that are not the version in use or previous of an
// installed plugin, and the sidecar folders and version folders that installed.json does not designate. It reports
// every folder that it could not remove.
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

// ChangePlugin removes an installed plugin or turns it on or off.
func ChangePlugin(configDir, id, action string) (any, error) {
	state, manifests, err := ReadInstalledManifests(configDir)
	if err != nil {
		return nil, err
	}
	plugin, installed := state.Plugins[id]
	if !installed {
		return nil, fmt.Errorf("plugin %s is not installed", id)
	}
	if action == "remove" || action == "disable" {
		name, err := InstalledName(configDir, plugin)
		if err != nil {
			return nil, err
		}
		// A plugin whose package another enabled plugin names as a dependency is neither removed nor disabled.
		for _, other := range sortedPluginIDs(state.Plugins) {
			dependent := state.Plugins[other]
			if other == id || !dependent.Enabled {
				continue
			}
			installed, ok := manifests[other]
			if !ok {
				return nil, fmt.Errorf("plugin %s has no installed manifest", other)
			}
			dependencies, err := manifestDependenciesOf(manifestFile(configDir, dependent), installed.Value)
			if err != nil {
				return nil, err
			}
			if rng, ok := dependencies[name]; ok {
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

// runPlugins runs registry use and plugin install, update, remove, enable, disable and list. The writing commands own
// the configuration directory for the duration of their write, so a running host or a second command refuses instead
// of racing the same files (docs/spec/installation.md).
func runPlugins(a arguments, stdout io.Writer, options Options) error {
	configDir, err := configDirOf(a.values, options)
	if err != nil {
		return err
	}
	if a.positionals[0] == "plugin" && a.positionals[1] != "list" {
		release, err := ownConfiguration(configDir)
		if err != nil {
			return err
		}
		defer release()
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
		// platform is needed only by install and update, which choose the version.
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
