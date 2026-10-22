package sok

// Writes plugin releases and sidecar releases (docs/spec/cli.md). Both are gzip-compressed tar files whose entries
// are in path order with modification time 0, owner 0 and mode 0644 or 0755. A failure leaves no file.

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

// releaseEntry is one file that goes into a release. path is relative to the folder and separated by /.
type releaseEntry struct {
	path       string
	source     string
	executable bool
}

// CurrentPlatform is the platform key on which sok runs.
func CurrentPlatform() (string, error) {
	current, err := platform.Current()
	if err != nil {
		return "", err
	}
	return current.Key()
}

// collect gathers the paths of package.json and files into release entries. A folder is gathered with the files below
// it. A symbolic link and a file that is neither a regular file nor a folder are rejected.
func collect(dir string, listed []string) ([]releaseEntry, error) {
	seen := map[string]bool{}
	var entries []releaseEntry
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
			return fmt.Errorf("%s is a symbolic link; an release holds no links", path)
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
			entries = append(entries, releaseEntry{path: path, source: source, executable: info.Mode()&0o111 != 0})
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
	slices.SortFunc(entries, func(a, b releaseEntry) int { return strings.Compare(a.path, b.path) })
	return entries, nil
}

// writeRelease writes the entries to output and returns their sha256. It writes to a temporary file in the same folder
// and then renames it, so output does not change when the write fails.
func writeRelease(entries []releaseEntry, output string) (sum string, err error) {
	temp, err := os.CreateTemp(filepath.Dir(output), "."+filepath.Base(output)+".*")
	if err != nil {
		return "", fileError(output, err)
	}
	defer func() {
		if err == nil {
			return
		}
		// A failed write closes and removes the temporary file. A file that is already closed is not a close error.
		if closeErr := temp.Close(); closeErr != nil && !errors.Is(closeErr, os.ErrClosed) {
			err = fmt.Errorf("%w; close %w", err, fileError(temp.Name(), closeErr))
		}
		err = withCleanup(err, temp.Name(), os.Remove)
	}()
	hash := sha256.New()
	zipped := gzip.NewWriter(io.MultiWriter(temp, hash))
	release := tar.NewWriter(zipped)
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
		if err := release.WriteHeader(header); err != nil {
			return "", err
		}
		if _, err := release.Write(data); err != nil {
			return "", err
		}
	}
	for _, closer := range []io.Closer{release, zipped, temp} {
		if err := closer.Close(); err != nil {
			return "", err
		}
	}
	if err := os.Rename(temp.Name(), output); err != nil {
		return "", fileError(output, err)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// readJSONFile reads one JSON file of the folder into the value that the format check uses.
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

// printJSON writes the result with two-space indentation. It turns off HTML escaping so that &, < and > of a path are
// written unchanged.
func printJSON(stdout io.Writer, value any) error {
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

// outputPath creates the output folder and returns the absolute path inside it.
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

// covers reports whether one path of files is path or a folder that contains path.
func covers(listed []string, path string) bool {
	return slices.ContainsFunc(listed, func(file string) bool {
		return path == file || strings.HasPrefix(path, strings.TrimSuffix(file, "/")+"/")
	})
}

// binarySegment is the path segment that the binary store of a page reserves. The host answers that path before it
// looks up a file, so a plugin release cannot hold a file under it (docs/spec/native-surfaces.md).
const binarySegment = ".binary"

// checkReleaseFiles refuses a listed path that has a binarySegment part, with the same text as validateReleaseFiles
// of @soksak/plugin-api.
func checkReleaseFiles(listed []string) error {
	for _, file := range listed {
		if slices.Contains(strings.Split(file, "/"), binarySegment) {
			return fmt.Errorf("plugin release lists %s: the %s path is reserved for the binary store", file, binarySegment)
		}
	}
	return nil
}

// checkRemovedFields refuses the manifest fields that the reader removed: the state module and the module of a section. The error
// names the plugin and the field, as plugin-api validateManifest does (docs/spec/plugins.md, docs/spec/declared-ui.md).
func checkRemovedFields(id string, manifest map[string]any) error {
	if _, ok := manifest["state"]; ok {
		return fmt.Errorf("plugin %s: state is removed; a plugin keeps project data through its host (docs/spec/plugins.md#project-data)", id)
	}
	if sections, ok := manifest["sections"].([]any); ok {
		for _, raw := range sections {
			section, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if _, ok := section["module"]; ok {
				sectionID, _ := text(section["id"])
				return fmt.Errorf("plugin %s: section %s module is removed; a section takes status (docs/spec/declared-ui.md)", id, sectionID)
			}
		}
	}
	return nil
}

// manifestModules are the modules that plugin.json loads and their names: the surface module, the page of a view
// composition, the module of each section, and the state.
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

// diagnosticFiles are diagnostics.json of the plugin folder and its module path. Without diagnostics.json it is empty.
// The two files are not listed in files (docs/spec/plugins.md).
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

// runPack checks the plugin folder and writes `<id>-<version>.tgz`. When diagnostics is true, it also includes the
// diagnostic declarations.
func runPack(dir, out string, diagnostics bool, stdout io.Writer) error {
	value, err := readJSONFile(dir, "package.json")
	if err != nil {
		return err
	}
	if err := ValidatePackageJSON(value); err != nil {
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
	if _, err := ManifestDependencies(manifest); err != nil {
		return err
	}
	if err := checkRemovedFields(id, manifest); err != nil {
		return err
	}
	listed := listedFiles(pkg)
	if err := checkReleaseFiles(listed); err != nil {
		return err
	}
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
	output, err := outputPath(out, ReleaseName(id, version))
	if err != nil {
		return err
	}
	sum, err := writeRelease(entries, output)
	if err != nil {
		return err
	}
	return printJSON(stdout, map[string]string{"id": id, "version": version, "release": output, "sha256": sum})
}

// runRelease checks a sidecar folder, writes its release and updates SHA256SUMS.
func runRelease(dir, out, platform string, stdout io.Writer) error {
	value, err := readJSONFile(dir, "package.json")
	if err != nil {
		return err
	}
	pkg, err := object("package.json", value)
	if err != nil {
		return err
	}
	if err := checkPackageJSONName("package.json name", pkg["name"]); err != nil {
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
	if replay, declared := sidecar["replay"]; declared {
		replayObject, err := object("sidecar.json replay", replay)
		if err != nil {
			return err
		}
		replayExecutable, ok := text(replayObject["executable"])
		if !ok {
			return fmt.Errorf("sidecar.json: replay.executable is required")
		}
		if !slices.Contains(listed, replayExecutable) {
			return fmt.Errorf("package.json files: %s, the replay executable of sidecar.json, is not listed", replayExecutable)
		}
	}
	name, version := pkg["name"].(string), pkg["version"].(string)
	file, err := SidecarReleaseName(name, version, platform)
	if err != nil {
		return err
	}
	entries, err := collect(dir, listed)
	if err != nil {
		return err
	}
	output, err := outputPath(out, file)
	if err != nil {
		return err
	}
	// SHA256SUMS is read first, so no release is written when that file is wrong.
	sumsPath := filepath.Join(filepath.Dir(output), "SHA256SUMS")
	sums, err := readSums(sumsPath)
	if err != nil {
		return err
	}
	sum, err := writeRelease(entries, output)
	if err != nil {
		return err
	}
	sums[file] = sum
	if err := writeSums(sumsPath, sums); err != nil {
		return err
	}
	return printJSON(stdout, map[string]string{"name": name, "version": version, "platform": platform, "release": output, "sha256": sum})
}

// readSums reads SHA256SUMS as the sha256 of each release name. When the file does not exist, the list is empty.
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
			return nil, fmt.Errorf("%s line %d is not \"<sha256>  <release name>\"", path, i+1)
		}
		sums[name] = hash
	}
	return sums, nil
}

// writeSums writes SHA256SUMS in the order of release names.
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

// replaceFile writes data to a temporary file in the same folder and then renames it, which replaces path in one step.
func replaceFile(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return fileError(path, err)
	}
	_, err = temp.Write(data)
	// The data is on disk before the rename replaces the destination, so a crash cannot leave a cut file; the twin of
	// this package in the other language syncs the same way.
	if err == nil {
		err = temp.Sync()
	}
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
