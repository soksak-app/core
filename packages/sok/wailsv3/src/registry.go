package sok

// registry 폴더를 검사하고 index.json 을 쓴다(docs/spec/cli.md). 모든 검사를 통과할 때만 index.json 을 한 번에
// 바꾼다.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"path/filepath"
	"slices"
	"strings"
)

// readEntries 는 registry 의 한 폴더에서 *.json 파일을 이름 순서로 읽고, 항목을 검사한 뒤 파일 이름이 항목과
// 맞는지 본다.
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

// archiveFiles 는 tar.gz 의 최상위 파일 중 names 의 내용을 읽는다.
func archiveFiles(data []byte, names ...string) (map[string][]byte, error) {
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
		if slices.Contains(names, header.Name) {
			if found[header.Name], err = io.ReadAll(reader); err != nil {
				return nil, err
			}
		}
	}
	for _, name := range names {
		if found[name] == nil {
			return nil, fmt.Errorf("the archive holds no %s", name)
		}
	}
	return found, nil
}

// readArchive 는 archive 주소의 본문을 읽고 sha256 을 비교한다.
func readArchive(where string, archive Archive) ([]byte, error) {
	data, err := DefaultFetcher.Read(archive.URL, DefaultFetcher.Archive)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", where, err)
	}
	// 오류는 file: 이면 경로를, https: 면 URL 을 밝힌다.
	shown := archive.URL
	if path, err := FilePath(archive.URL); err == nil {
		shown = path
	}
	sum := sha256.Sum256(data)
	if got := hex.EncodeToString(sum[:]); got != archive.SHA256 {
		return nil, fmt.Errorf("%s: %s has sha256 %s, the entry says %s", where, shown, got, archive.SHA256)
	}
	return data, nil
}

// checkPluginArchive 는 plugin archive 가 항목의 plugin.json id 와 package.json 을 담는지 본다.
func checkPluginArchive(plugin *RegistryPlugin, version *PluginVersion) error {
	where := "plugin " + plugin.ID + " " + version.Version + " package"
	data, err := readArchive(where, version.Package)
	if err != nil {
		return err
	}
	files, err := archiveFiles(data, "package.json", "plugin.json")
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
	if err := ValidatePluginPackage(value); err != nil {
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
	if sidecars := PackageSidecars(pkg); !maps.Equal(sidecars, version.Sidecars) {
		return fmt.Errorf("%s: package.json soksak.sidecars %s differ from the entry %s", where, quote(sidecars), quote(version.Sidecars))
	}
	return nil
}

// BuildRegistry 는 registry 폴더를 검사하고 index.json 을 쓴 뒤 그 경로와 항목 수를 돌려준다.
func BuildRegistry(dir string) (map[string]any, error) {
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
	index, err := ValidateRegistryIndex(map[string]any{
		"format": json.Number("1"), "plugins": plugins, "sidecars": sidecars, "packs": packs, "revoked": revoked,
	})
	if err != nil {
		return nil, err
	}
	// 파일 이름 순서는 @scope 이름의 순서와 다르므로 목록을 id 와 이름으로 다시 정렬한다.
	slices.SortFunc(index.Plugins, func(a, b RegistryPlugin) int { return strings.Compare(a.ID, b.ID) })
	slices.SortFunc(index.Sidecars, func(a, b RegistrySidecar) int { return strings.Compare(a.Name, b.Name) })
	slices.SortFunc(index.Packs, func(a, b RegistryPack) int { return strings.Compare(a.Name, b.Name) })
	for i := range index.Plugins {
		plugin := &index.Plugins[i]
		for j := range plugin.Versions {
			if err := checkPluginArchive(plugin, &plugin.Versions[j]); err != nil {
				return nil, err
			}
		}
	}
	for _, sidecar := range index.Sidecars {
		for _, version := range sidecar.Versions {
			for _, platform := range slices.Sorted(maps.Keys(version.Assets)) {
				if _, err := readArchive("sidecar "+sidecar.Name+" "+version.Version+" "+platform, version.Assets[platform]); err != nil {
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
	return map[string]any{"index": path, "plugins": len(index.Plugins), "sidecars": len(index.Sidecars), "packs": len(index.Packs)}, nil
}

// runRegistry 는 `sok registry build <directory>` 를 실행한다.
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
	result, err := BuildRegistry(dir)
	if err != nil {
		return err
	}
	return printJSON(stdout, result)
}
