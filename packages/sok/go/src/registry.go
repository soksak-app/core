package sok

// Checks a registry folder and writes index.json (docs/spec/cli.md). index.json is replaced in one step only when every
// check passes.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// readEntries reads the *.json files of one registry folder in name order, checks each entry and checks that the file
// name matches the entry.
func readEntries(dir, kind string, validate func(any) error, fileName func(map[string]any) (string, error)) ([]any, error) {
	names, err := filepath.Glob(filepath.Join(dir, kind, "*.json"))
	if err != nil {
		return nil, err
	}
	slices.Sort(names)
	entries := []any{}
	for _, path := range names {
		value, err := readJSONFile(filepath.Dir(path), filepath.Base(path))
		if err != nil {
			return nil, err
		}
		if err := validate(value); err != nil {
			return nil, fmt.Errorf("%s/%s: %w", kind, filepath.Base(path), err)
		}
		want, err := fileName(value.(map[string]any))
		if err != nil {
			return nil, err
		}
		if filepath.Base(path) != want+".json" {
			return nil, fmt.Errorf("%s/%s holds %s; its file name must be %s.json", kind, filepath.Base(path), want, want)
		}
		entries = append(entries, value)
	}
	return entries, nil
}

// packageRoot is the folder of every entry of a plugin or sidecar release, the layout that `npm pack` writes
// (docs/spec/installation.md#plugin-release).
const packageRoot = "package/"

// binarySegment is the path segment that the binary store of a page reserves. The host answers that path before it
// looks up a file, so a plugin release cannot hold a file under it (docs/spec/native-surfaces.md).
const binarySegment = ".binary"

// manifestModules are the modules that plugin.json loads and their names: the surface module, the page of a view
// composition.
func manifestModules(manifest map[string]any) [][2]string {
	var modules [][2]string
	add := func(what string, value any) {
		if module, ok := value.(string); ok {
			modules = append(modules, [2]string{what, module})
		}
	}
	if surface, ok := manifest["surface"].(map[string]any); ok {
		add("surface module", surface["module"])
		if composition, ok := surface["composition"].(map[string]any); ok && composition["kind"] == "view" {
			add("view page", composition["page"])
		}
	}
	return modules
}

// releasePaths are the paths of the files of a release under packageRoot, without that folder. extract refuses an entry
// outside it.
func releasePaths(data []byte) (map[string]bool, error) {
	zipped, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	reader := tar.NewReader(zipped)
	paths := map[string]bool{}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return paths, nil
		}
		if err != nil {
			return nil, err
		}
		if name, ok := strings.CutPrefix(header.Name, packageRoot); ok {
			paths[name] = true
		}
	}
}

// checkReleaseModules checks the files of a plugin release against its plugin.json: no file is under a binarySegment
// folder, and every module that plugin.json loads is a file of the release.
func checkReleaseModules(data []byte, manifest map[string]any) error {
	paths, err := releasePaths(data)
	if err != nil {
		return err
	}
	names := slices.Sorted(maps.Keys(paths))
	for _, name := range names {
		if slices.Contains(strings.Split(name, "/"), binarySegment) {
			return fmt.Errorf("plugin release holds %s: the %s path is reserved for the binary store", name, binarySegment)
		}
	}
	for _, module := range manifestModules(manifest) {
		if !paths[module[1]] {
			return fmt.Errorf("plugin.json: %s %s is not in the release", module[0], module[1])
		}
	}
	return nil
}

// checkSidecarRelease checks the files of a sidecar release against its sidecar.json: the executable and the replay
// executable that it names are files of the release (docs/spec/installation.md#sidecar-release).
func checkSidecarRelease(data []byte) error {
	files, err := releaseFiles(data, "sidecar.json")
	if err != nil {
		return err
	}
	var declaration struct {
		Executable any `json:"executable"`
		Replay     *struct {
			Executable any `json:"executable"`
		} `json:"replay"`
	}
	if err := json.Unmarshal(files["sidecar.json"], &declaration); err != nil {
		return fmt.Errorf("sidecar.json is not valid JSON: %w", err)
	}
	paths, err := releasePaths(data)
	if err != nil {
		return err
	}
	declared := [][2]any{{"executable", declaration.Executable}}
	if declaration.Replay != nil {
		declared = append(declared, [2]any{"replay.executable", declaration.Replay.Executable})
	}
	for _, item := range declared {
		path, ok := item[1].(string)
		if !ok {
			return fmt.Errorf("sidecar.json: %s must be a path", item[0])
		}
		if !paths[path] {
			return fmt.Errorf("sidecar.json: %s %s is not in the release", item[0], path)
		}
	}
	return nil
}

// releaseFiles reads the content of the files of a release that are listed in names, each from `package/<name>`.
func releaseFiles(data []byte, names ...string) (map[string][]byte, error) {
	zipped, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	reader := tar.NewReader(zipped)
	found := map[string][]byte{}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		name, ok := strings.CutPrefix(header.Name, packageRoot)
		if ok && slices.Contains(names, name) {
			if found[name], err = io.ReadAll(reader); err != nil {
				return nil, err
			}
		}
	}
	for _, name := range names {
		if found[name] == nil {
			return nil, fmt.Errorf("the release holds no %s", name)
		}
	}
	return found, nil
}

// readRelease reads the body at the release address and compares its sha256.
func readRelease(where string, release Release) ([]byte, error) {
	data, err := DefaultFetcher.Read(release.URL, DefaultFetcher.Release)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", where, err)
	}
	// For file: the error names the path, and for https: it names the URL.
	shown := release.URL
	if path, err := FilePath(release.URL); err == nil {
		shown = path
	}
	sum := sha256.Sum256(data)
	if got := hex.EncodeToString(sum[:]); got != release.SHA256 {
		return nil, fmt.Errorf("%s: %s has sha256 %s, the entry says %s", where, shown, got, release.SHA256)
	}
	return data, nil
}

// checkPluginRelease checks that a plugin release holds the plugin.json id and the package.json of its entry, that the
// sidecar dependencies of plugin.json equal the sidecars of the entry, and that a listed version satisfies the range of
// each plugin dependency.
func checkPluginRelease(index *Index, plugin *RegistryPlugin, version *PluginVersion) error {
	where := "plugin " + plugin.ID + " " + version.Version + " package"
	data, err := readRelease(where, version.Release)
	if err != nil {
		return err
	}
	files, err := releaseFiles(data, "package.json", "plugin.json")
	if err != nil {
		return fmt.Errorf("%s: %w", where, err)
	}
	manifest, err := DecodeJSON(files["plugin.json"])
	if err != nil {
		return fmt.Errorf("%s: plugin.json is not valid JSON: %w", where, err)
	}
	if m, ok := manifest.(map[string]any); !ok || m["id"] != plugin.ID {
		return fmt.Errorf("%s: plugin.json id is not %s", where, plugin.ID)
	}
	value, err := DecodeJSON(files["package.json"])
	if err != nil {
		return fmt.Errorf("%s: package.json is not valid JSON: %w", where, err)
	}
	if err := ValidatePackageJSON(value); err != nil {
		return fmt.Errorf("%s: %w", where, err)
	}
	pkg := value.(map[string]any)
	engines := pkg["engines"].(map[string]any)
	for _, field := range [][3]string{
		{"name", pkg["name"].(string), plugin.Package},
		{"version", pkg["version"].(string), version.Version},
		{"engines.soksak", engines["soksak"].(string), version.Engines.Soksak},
	} {
		if field[1] != field[2] {
			return fmt.Errorf("%s: package.json %s is %s, the entry says %s", where, field[0], field[1], field[2])
		}
	}
	dependencies, err := ManifestDependencies(manifest.(map[string]any))
	if err != nil {
		return fmt.Errorf("%s: %w", where, err)
	}
	plugins, sidecars, err := ClassifyDependencies(index, plugin.ID, version.Version, dependencies)
	if err != nil {
		return err
	}
	if !maps.Equal(sidecars, version.Sidecars) {
		return fmt.Errorf("%s: plugin.json dependencies %s differ from the entry %s", where, quote(sidecars), quote(version.Sidecars))
	}
	version.Plugins = plugins
	return checkPluginDependencies(index, plugin, version)
}

// checkPluginDependencies judges the plugin dependencies that a plugin version records in the index: each names a listed
// plugin, and a listed version of that plugin satisfies its range. A read version and a carried version are judged alike,
// so a carried version whose dependency has no listed version fails the build.
func checkPluginDependencies(index *Index, plugin *RegistryPlugin, version *PluginVersion) error {
	for _, name := range sortedNames(version.Plugins) {
		i := slices.IndexFunc(index.Plugins, func(entry RegistryPlugin) bool { return entry.Package == name })
		if i < 0 {
			return fmt.Errorf("%s %s: dependency %s is neither a plugin nor a sidecar of the registry", plugin.ID, version.Version, name)
		}
		rng := version.Plugins[name]
		if !slices.ContainsFunc(index.Plugins[i].Versions, func(candidate PluginVersion) bool { return Satisfies(candidate.Version, rng) }) {
			return fmt.Errorf("%s %s: plugin dependency %s %s is satisfied by no listed version", plugin.ID, version.Version, name, rng)
		}
	}
	return nil
}

// readPreviousIndex reads the index that a previous publication wrote from location and checks it as a registry index.
// A failure names location, and the caller writes nothing.
func readPreviousIndex(location string) (*Index, error) {
	data, err := DefaultFetcher.ReadIndex(location)
	if err != nil {
		return nil, fmt.Errorf("previous index: %w", err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, fmt.Errorf("previous index %s is not valid JSON: %w", location, err)
	}
	index, err := ValidateRegistryIndex(value)
	if err != nil {
		return nil, fmt.Errorf("previous index %s: %w", location, err)
	}
	return index, nil
}

// listedPlugin returns the version of the previous index that has the same plugin identity and version record as version,
// or nil when the previous index does not list it. Such a release keeps the hash that the previous build checked, and
// its recorded plugin dependencies are carried with it.
func listedPlugin(previous *Index, plugin *RegistryPlugin, version *PluginVersion) *PluginVersion {
	if previous == nil {
		return nil
	}
	i := slices.IndexFunc(previous.Plugins, func(entry RegistryPlugin) bool { return entry.ID == plugin.ID })
	if i < 0 {
		return nil
	}
	old := &previous.Plugins[i]
	if old.Package != plugin.Package || old.Name != plugin.Name || old.Repository != plugin.Repository {
		return nil
	}
	j := slices.IndexFunc(old.Versions, func(candidate PluginVersion) bool { return candidate.Version == version.Version })
	if j < 0 {
		return nil
	}
	listed := &old.Versions[j]
	if listed.Release != version.Release || listed.Engines != version.Engines || !maps.Equal(listed.Sidecars, version.Sidecars) {
		return nil
	}
	return listed
}

// carriedSidecar reports whether the previous index lists the release of one platform of the sidecar version with the
// same identity, version and protocol.
func carriedSidecar(previous *Index, sidecar *RegistrySidecar, version *SidecarVersion, platform string, release Release) bool {
	if previous == nil {
		return false
	}
	i := slices.IndexFunc(previous.Sidecars, func(entry RegistrySidecar) bool { return entry.Name == sidecar.Name })
	if i < 0 || previous.Sidecars[i].Repository != sidecar.Repository {
		return false
	}
	j := slices.IndexFunc(previous.Sidecars[i].Versions, func(candidate SidecarVersion) bool { return candidate.Version == version.Version })
	if j < 0 {
		return false
	}
	listed := previous.Sidecars[i].Versions[j]
	listedRelease, ok := listed.Releases[platform]
	return ok && listed.Protocol == version.Protocol && listedRelease == release
}

// carriedCore reports whether the previous index lists the release of one key of the core version.
func carriedCore(previous *Index, version *CoreRelease, key string, release Release) bool {
	if previous == nil || previous.Core == nil {
		return false
	}
	j := slices.IndexFunc(previous.Core.Versions, func(candidate CoreRelease) bool { return candidate.Version == version.Version })
	if j < 0 {
		return false
	}
	listed, ok := previous.Core.Versions[j].Releases[key]
	return ok && listed == release
}

// BuildRegistry checks the registry folder, writes index.json and returns its path and the counts of its entries and of
// the releases that it read and carried. A nil previous index is a first build that reads every release
// (docs/spec/registry.md#build).
func BuildRegistry(dir string, previous *Index) (map[string]any, error) {
	plugins, err := readEntries(dir, "plugins", ValidateRegistryPlugin, func(m map[string]any) (string, error) { return m["id"].(string), nil })
	if err != nil {
		return nil, err
	}
	sidecars, err := readEntries(dir, "sidecars", ValidateRegistrySidecar, func(m map[string]any) (string, error) { return SidecarFileName(m["name"].(string)) })
	if err != nil {
		return nil, err
	}
	packs, err := readEntries(dir, "packs", ValidateRegistryPack, func(m map[string]any) (string, error) { return m["name"].(string), nil })
	if err != nil {
		return nil, err
	}
	revoked, err := readJSONFile(dir, "revoked.json")
	if err != nil {
		return nil, err
	}
	// Each version records its plugin dependencies in the index, which an entry does not hold. The record is set below,
	// after the index is read: a carried version takes the record of the previous index, and a read version takes the
	// dependencies of its plugin.json. The placeholder only satisfies the index validation.
	for _, entry := range plugins {
		for _, raw := range entry.(map[string]any)["versions"].([]any) {
			raw.(map[string]any)["plugins"] = map[string]any{}
		}
	}
	root := map[string]any{"format": json.Number(strconv.Itoa(RegistryIndexFormat)), "plugins": plugins, "sidecars": sidecars, "packs": packs, "revoked": revoked}
	// A registry without core.json lists no core release.
	if _, err := os.Stat(filepath.Join(dir, "core.json")); err == nil {
		if root["core"], err = readJSONFile(dir, "core.json"); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	index, err := ValidateRegistryIndex(root)
	if err != nil {
		return nil, err
	}
	// The order of file names differs from the order of @scope names, so the list is sorted again by id and name.
	slices.SortFunc(index.Plugins, func(a, b RegistryPlugin) int { return strings.Compare(a.ID, b.ID) })
	slices.SortFunc(index.Sidecars, func(a, b RegistrySidecar) int { return strings.Compare(a.Name, b.Name) })
	slices.SortFunc(index.Packs, func(a, b RegistryPack) int { return strings.Compare(a.Name, b.Name) })
	read, carried := 0, 0
	for i := range index.Plugins {
		plugin := &index.Plugins[i]
		for j := range plugin.Versions {
			version := &plugin.Versions[j]
			if listed := listedPlugin(previous, plugin, version); listed != nil {
				carried++
				version.Plugins = listed.Plugins
				if err := checkPluginDependencies(index, plugin, version); err != nil {
					return nil, err
				}
				continue
			}
			read++
			if err := checkPluginRelease(index, plugin, version); err != nil {
				return nil, err
			}
		}
	}
	for i := range index.Sidecars {
		sidecar := &index.Sidecars[i]
		for j := range sidecar.Versions {
			version := &sidecar.Versions[j]
			for _, platform := range slices.Sorted(maps.Keys(version.Releases)) {
				release := version.Releases[platform]
				if carriedSidecar(previous, sidecar, version, platform, release) {
					carried++
					continue
				}
				read++
				if _, err := readRelease("sidecar "+sidecar.Name+" "+version.Version+" "+platform, release); err != nil {
					return nil, err
				}
			}
		}
	}
	cores := 0
	if index.Core != nil {
		slices.SortFunc(index.Core.Versions, func(a, b CoreRelease) int { return strings.Compare(a.Version, b.Version) })
		for i := range index.Core.Versions {
			version := &index.Core.Versions[i]
			cores++
			for _, key := range slices.Sorted(maps.Keys(version.Releases)) {
				release := version.Releases[key]
				if carriedCore(previous, version, key, release) {
					carried++
					continue
				}
				read++
				if _, err := readRelease("core "+version.Version+" "+key, release); err != nil {
					return nil, err
				}
			}
		}
	}
	var out bytes.Buffer
	if err := printJSON(&out, index); err != nil {
		return nil, err
	}
	path, err := filepath.Abs(filepath.Join(dir, "index.json"))
	if err != nil {
		return nil, err
	}
	if err := replaceFile(path, out.Bytes()); err != nil {
		return nil, err
	}
	return map[string]any{"index": path, "plugins": len(index.Plugins), "sidecars": len(index.Sidecars), "packs": len(index.Packs), "core": cores, "read": read, "carried": carried}, nil
}

// runRegistry runs `sok registry build <directory>`.
func runRegistry(a arguments, stdout io.Writer) error {
	action, err := a.positional(1, "registry action")
	if err != nil {
		return err
	}
	if action != "build" {
		return usage("unknown command: registry %s", action)
	}
	dir, err := a.positional(2, "directory")
	if err != nil {
		return err
	}
	if len(a.positionals) > 3 {
		return usage("unexpected argument %s", a.positionals[3])
	}
	var previous *Index
	if location, given := a.values["previous"]; given {
		if previous, err = readPreviousIndex(location); err != nil {
			return err
		}
	}
	result, err := BuildRegistry(dir, previous)
	if err != nil {
		return err
	}
	return printJSON(stdout, result)
}
