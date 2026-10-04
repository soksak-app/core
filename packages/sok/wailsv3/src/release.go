package sok

// plugin package archive 와 sidecar release asset 을 쓴다(docs/spec/cli.md). 두 archive 는 gzip 으로 압축한 tar
// 이며, 항목은 경로 순서이고 수정 시각 0, 소유자 0, mode 0644 또는 0755 다. 실패하면 아무 파일도 남기지 않는다.

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

// archiveEntry 는 archive 에 넣는 파일 하나다. path 는 폴더 기준 상대 경로이며 / 로 나눈다.
type archiveEntry struct {
	path       string
	source     string
	executable bool
}

// CurrentPlatform 은 sok 이 실행되는 플랫폼 key 다.
func CurrentPlatform() (string, error) {
	current, err := platform.Current()
	if err != nil {
		return "", err
	}
	return current.Key()
}

// collect 는 package.json 과 files 의 경로를 archive 항목으로 모은다. 폴더는 그 아래 파일까지 모으고, symbolic
// link 나 일반 파일도 폴더도 아닌 파일은 거부한다.
func collect(dir string, listed []string) ([]archiveEntry, error) {
	seen := map[string]bool{}
	var entries []archiveEntry
	var add func(path string) error
	add = func(path string) error {
		if seen[path] {
			return nil
		}
		seen[path] = true
		source := filepath.Join(dir, filepath.FromSlash(path))
		info, err := os.Lstat(source)
		if err != nil {
			return fileError(path, err)
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			return fmt.Errorf("%s is a symbolic link; an archive holds no links", path)
		case info.IsDir():
			children, err := os.ReadDir(source)
			if err != nil {
				return fileError(path, err)
			}
			for _, child := range children {
				if err := add(path + "/" + child.Name()); err != nil {
					return err
				}
			}
		case info.Mode().IsRegular():
			entries = append(entries, archiveEntry{path: path, source: source, executable: info.Mode()&0o111 != 0})
		default:
			return fmt.Errorf("%s is neither a regular file nor a directory", path)
		}
		return nil
	}
	for _, path := range append([]string{"package.json"}, listed...) {
		path = strings.TrimSuffix(path, "/")
		if path == "" || strings.HasPrefix(path, "/") || slices.Contains(strings.Split(path, "/"), "..") {
			return nil, fmt.Errorf("%s leaves the directory", path)
		}
		if err := add(path); err != nil {
			return nil, err
		}
	}
	slices.SortFunc(entries, func(a, b archiveEntry) int { return strings.Compare(a.path, b.path) })
	return entries, nil
}

// writeArchive 는 항목을 output 에 쓰고 그 sha256 을 돌려준다. 같은 폴더의 임시 파일에 쓴 뒤 이름을 바꾸므로
// 실패하면 output 은 바뀌지 않는다.
func writeArchive(entries []archiveEntry, output string) (sum string, err error) {
	temp, err := os.CreateTemp(filepath.Dir(output), "."+filepath.Base(output)+".*")
	if err != nil {
		return "", fileError(output, err)
	}
	defer func() {
		if err == nil {
			return
		}
		// 실패한 쓰기는 임시 파일을 닫고 지운다. 이미 닫힌 파일은 닫기 오류가 아니다.
		if closeErr := temp.Close(); closeErr != nil && !errors.Is(closeErr, os.ErrClosed) {
			err = fmt.Errorf("%w; close %w", err, fileError(temp.Name(), closeErr))
		}
		err = withCleanup(err, temp.Name(), os.Remove)
	}()
	hash := sha256.New()
	zipped := gzip.NewWriter(io.MultiWriter(temp, hash))
	archive := tar.NewWriter(zipped)
	for _, entry := range entries {
		data, err := os.ReadFile(entry.source)
		if err != nil {
			return "", fileError(entry.path, err)
		}
		mode := int64(0o644)
		if entry.executable {
			mode = 0o755
		}
		header := &tar.Header{Typeflag: tar.TypeReg, Name: entry.path, Mode: mode, Size: int64(len(data)), ModTime: time.Unix(0, 0)}
		if err := archive.WriteHeader(header); err != nil {
			return "", err
		}
		if _, err := archive.Write(data); err != nil {
			return "", err
		}
	}
	for _, closer := range []io.Closer{archive, zipped, temp} {
		if err := closer.Close(); err != nil {
			return "", err
		}
	}
	if err := os.Rename(temp.Name(), output); err != nil {
		return "", fileError(output, err)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// readJSONFile 은 폴더의 JSON 파일 하나를 형식 검사에 쓰는 값으로 읽는다.
func readJSONFile(dir, name string) (any, error) {
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return nil, fileError(filepath.Join(dir, name), err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", filepath.Join(dir, name), err)
	}
	return value, nil
}

func listedFiles(pkg map[string]any) []string {
	var files []string
	for _, file := range pkg["files"].([]any) {
		files = append(files, file.(string))
	}
	return files
}

// printJSON 은 결과를 두 칸 들여쓰기로 쓴다. 경로의 &, <, > 를 그대로 쓰도록 HTML escape 를 끈다.
func printJSON(stdout io.Writer, value any) error {
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

// outputPath 는 출력 폴더를 만들고 그 안의 절대 경로를 돌려준다.
func outputPath(dir, name string) (string, error) {
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(absolute, 0o755); err != nil {
		return "", fileError(absolute, err)
	}
	return filepath.Join(absolute, name), nil
}

// covers 는 files 의 경로 하나가 path 이거나 path 를 담은 폴더인지 알려 준다.
func covers(listed []string, path string) bool {
	return slices.ContainsFunc(listed, func(file string) bool {
		return path == file || strings.HasPrefix(path, strings.TrimSuffix(file, "/")+"/")
	})
}

// manifestModules 는 plugin.json 이 불러오는 module 과 그 이름이다: surface, section 마다의 module, state.
func manifestModules(manifest map[string]any) [][2]string {
	var modules [][2]string
	add := func(what string, value any) {
		if module, ok := value.(string); ok {
			modules = append(modules, [2]string{what, module})
		}
	}
	if surface, ok := manifest["surface"].(map[string]any); ok {
		add("surface module", surface["module"])
	}
	if sections, ok := manifest["sections"].([]any); ok {
		for _, raw := range sections {
			section, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			what := "section module"
			if id, ok := section["id"].(string); ok {
				what = "section " + id + " module"
			}
			if orientations, ok := section["module"].(map[string]any); ok {
				add(what, orientations["horizontal"])
				add(what, orientations["vertical"])
			} else {
				add(what, section["module"])
			}
		}
	}
	if state, ok := manifest["state"].(map[string]any); ok {
		add("state module", state["module"])
	}
	return modules
}

// diagnosticFiles 는 plugin 폴더의 diagnostics.json 과 그 module 경로다. diagnostics.json 이 없으면 비어 있다.
// 두 파일은 files 에 나열하지 않는다(docs/spec/plugins.md).
func diagnosticFiles(dir string, listed []string) ([]string, error) {
	value, err := readJSONFile(dir, "diagnostics.json")
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	declared, err := object("diagnostics.json", value)
	if err != nil {
		return nil, err
	}
	module, ok := text(declared["module"])
	if !ok || strings.HasPrefix(module, "/") || slices.Contains(strings.Split(module, "/"), "..") || !strings.HasSuffix(module, ".js") {
		return nil, fmt.Errorf("diagnostics.json: module must be a JavaScript path inside the package")
	}
	for _, path := range []string{"diagnostics.json", module} {
		if covers(listed, path) {
			return nil, fmt.Errorf("package.json files: %s is diagnostic and must not be listed", path)
		}
	}
	return []string{"diagnostics.json", module}, nil
}

// runPack 은 plugin 폴더를 검사하고 `<id>-<version>.tgz` 를 쓴다. diagnostics 가 참이면 진단 선언도 담는다.
func runPack(dir, out string, diagnostics bool, stdout io.Writer) error {
	value, err := readJSONFile(dir, "package.json")
	if err != nil {
		return err
	}
	if err := ValidatePluginPackage(value); err != nil {
		return err
	}
	pkg := value.(map[string]any)
	manifestValue, err := readJSONFile(dir, "plugin.json")
	if err != nil {
		return err
	}
	manifest, err := object("plugin.json", manifestValue)
	if err != nil {
		return err
	}
	id, ok := text(manifest["id"])
	if !ok || !isIdentifier(id) {
		return fmt.Errorf("plugin.json: id must be a lowercase identifier")
	}
	if _, err := ManifestSidecars(manifest); err != nil {
		return err
	}
	listed := listedFiles(pkg)
	for _, module := range manifestModules(manifest) {
		if !covers(listed, module[1]) {
			return fmt.Errorf("plugin.json: %s %s must be listed in files", module[0], module[1])
		}
	}
	extra, err := diagnosticFiles(dir, listed)
	if err != nil {
		return err
	}
	if diagnostics {
		listed = append(listed, extra...)
	}
	entries, err := collect(dir, listed)
	if err != nil {
		return err
	}
	version := pkg["version"].(string)
	output, err := outputPath(out, PluginArchiveName(id, version))
	if err != nil {
		return err
	}
	sum, err := writeArchive(entries, output)
	if err != nil {
		return err
	}
	return printJSON(stdout, map[string]string{"id": id, "version": version, "archive": output, "sha256": sum})
}

// runRelease 는 sidecar 폴더를 검사하고 release asset 을 쓴 뒤 SHA256SUMS 를 갱신한다.
func runRelease(dir, out, platform string, stdout io.Writer) error {
	value, err := readJSONFile(dir, "package.json")
	if err != nil {
		return err
	}
	pkg, err := object("package.json", value)
	if err != nil {
		return err
	}
	if err := checkPackageName("package.json name", pkg["name"]); err != nil {
		return err
	}
	if err := checkVersion("package.json version", pkg["version"]); err != nil {
		return err
	}
	files, err := array("package.json files", pkg["files"])
	if err != nil {
		return err
	}
	var listed []string
	for _, file := range files {
		path, ok := text(file)
		if !ok || strings.HasPrefix(path, "/") || slices.Contains(strings.Split(path, "/"), "..") {
			return fmt.Errorf("package.json files: expected paths inside the package")
		}
		listed = append(listed, path)
	}
	declaration, err := readJSONFile(dir, "sidecar.json")
	if err != nil {
		return err
	}
	sidecar, err := object("sidecar.json", declaration)
	if err != nil {
		return err
	}
	executable, ok := text(sidecar["executable"])
	if !ok {
		return fmt.Errorf("sidecar.json: executable is required")
	}
	for _, required := range []string{"sidecar.json", executable} {
		if !slices.Contains(listed, required) {
			return fmt.Errorf("package.json files: %s is not listed", required)
		}
	}
	name, version := pkg["name"].(string), pkg["version"].(string)
	asset, err := SidecarAssetName(name, version, platform)
	if err != nil {
		return err
	}
	entries, err := collect(dir, listed)
	if err != nil {
		return err
	}
	output, err := outputPath(out, asset)
	if err != nil {
		return err
	}
	// SHA256SUMS 를 먼저 읽으므로 그 파일이 틀리면 archive 를 쓰지 않는다.
	sumsPath := filepath.Join(filepath.Dir(output), "SHA256SUMS")
	sums, err := readSums(sumsPath)
	if err != nil {
		return err
	}
	sum, err := writeArchive(entries, output)
	if err != nil {
		return err
	}
	sums[asset] = sum
	if err := writeSums(sumsPath, sums); err != nil {
		return err
	}
	return printJSON(stdout, map[string]string{"name": name, "version": version, "platform": platform, "archive": output, "sha256": sum})
}

// readSums 는 SHA256SUMS 를 archive 이름마다 sha256 으로 읽는다. 파일이 없으면 빈 목록이다.
func readSums(path string) (map[string]string, error) {
	sums := map[string]string{}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return sums, nil
	}
	if err != nil {
		return nil, fileError(path, err)
	}
	for i, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		hash, name, found := strings.Cut(line, "  ")
		if !found || !isSHA256(hash) || name == "" {
			return nil, fmt.Errorf("%s line %d is not \"<sha256>  <archive name>\"", path, i+1)
		}
		sums[name] = hash
	}
	return sums, nil
}

// writeSums 는 SHA256SUMS 를 archive 이름 순서로 쓴다.
func writeSums(path string, sums map[string]string) error {
	names := make([]string, 0, len(sums))
	for name := range sums {
		names = append(names, name)
	}
	slices.Sort(names)
	var out strings.Builder
	for _, name := range names {
		out.WriteString(sums[name] + "  " + name + "\n")
	}
	return replaceFile(path, []byte(out.String()))
}

// replaceFile 은 같은 폴더의 임시 파일에 data 를 쓴 뒤 이름을 바꿔 path 를 한 번에 바꾼다.
func replaceFile(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return fileError(path, err)
	}
	_, err = temp.Write(data)
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temp.Name(), path)
	}
	if err != nil {
		return withCleanup(fileError(path, err), temp.Name(), os.Remove)
	}
	return nil
}
